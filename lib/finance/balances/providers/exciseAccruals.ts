/**
 * Excise accrued per taxing authority, read from the shipment record.
 *
 * ── One shape, two authorities ───────────────────────────────────────────────
 * Every shipment writes an `export_transaction_taxes` child row per excise
 * rate that applies to it, carrying the money already worked out at ship time.
 * So an excise liability is a SUM, not a calculation: take the rows belonging
 * to this authority's rate, add up what they say, subtract what has been paid.
 * That is the whole provider.
 *
 * This deliberately does NOT recompute barrels x rate. The shipment record is
 * the book of record -- it is what the customer was invoiced and what the
 * return was filed from -- and a second derivation of the same number is a
 * second number that can disagree with the first. An earlier draft of this
 * file did recompute; it agreed to within $0.18 over the first quarter, which
 * is exactly the kind of small silent divergence worth not having.
 *
 * ── Route by rate id, never by tax name ──────────────────────────────────────
 * `export_transaction_taxes.tax_name` is a label copied in at write time and
 * it has two generations in live data: "NC Excise Tax" and "NC Beer Excise
 * Tax" are the same tax, as are "Federal Excise Tax" and "Federal Beer Excise
 * Tax". Matching on the name silently drops half the history. `excise_tax_rate_id`
 * is a foreign key to `tax_rates`, whose `party_key` says which authority is
 * owed -- so that is what routes here, the same way `square_tax_accounts`
 * routes collected sales tax.
 *
 * ── Channel is the authority's rule, not the shipment's ──────────────────────
 * Tax rows are written for EVERY shipment regardless of channel
 * (`computeExciseTaxBreakdown` takes a volume and nothing else). The two
 * authorities then disagree about what is taxable: federally every removal is
 * taxed, while North Carolina excludes wholesale because the wholesaler remits
 * it (Form B-C-710 Line 4a). Summing the table blind would therefore over-state
 * the NC liability the moment a wholesale shipment lands. Each authority
 * declares its own taxable-channel set below, reusing the set the tax module's
 * return already uses rather than restating the rule.
 *
 * ── The floor ────────────────────────────────────────────────────────────────
 * A balance-sheet provider is asked about every month the snapshot covers,
 * including months before the brewery had this obligation. The TTB schedule
 * declares `first_period_start` = 2026-07-01 because of the ownership
 * transition, and without honouring it this would book the $129.70 of federal
 * excise recorded against May and June shipments as retroactive back tax.
 *
 * An UNDECLARED first period means no floor, and that is deliberate rather
 * than an oversight. `scheduleStartBoundary` falls back to the schedule row's
 * `created_at`, which is right for generating filing tasks and wrong here: the
 * NC excise schedule was created in July but its obligation reaches back to
 * the first shipment, and flooring NC at its creation date would drop the
 * accrual while keeping the payments -- reproducing the exact
 * settled-but-never-accrued asymmetry this provider exists to fix.
 *
 * No active schedule at all still returns NULL. That is the difference between
 * "this authority is not something we file for" and "we owe it nothing".
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { addDaysStr } from "@/lib/utils/datetime";
import { TAXABLE_CHANNELS as NC_TAXABLE_CHANNELS } from "@/lib/tax/parties/ncDorBeerExcise/rates";
import { TTB_TAXABLE_CHANNELS } from "@/lib/tax/parties/ttbBeerExcise/rates";
import { registerProvider, sharedRead } from "../registry";
import type { BalanceContext, BalanceProvider } from "../registry";

/** What one authority needs in order to be accrued. */
interface ExciseAuthority {
  /** `tax_rates.party_key` — which authority its excise rates are owed to. */
  partyKey: string;
  /** `tax_schedules.filing_key` — the schedule whose declared first period floors the accrual. */
  filingKey: string;
  /** Shipment channels this authority actually taxes. */
  taxableChannels: ReadonlySet<string>;
}

/**
 * The first date this authority's excise may be accrued from, or null for no
 * floor. Distinguishes "no schedule" (undefined -> provider returns null) from
 * "schedule with no declared first period" (null -> accrue everything).
 */
async function fetchDeclaredStart(sb: SupabaseClient, filingKey: string): Promise<string | null | undefined> {
  const { data, error } = await sb
    .from("tax_schedules")
    .select("config")
    .eq("filing_key", filingKey)
    .eq("active", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return undefined;
  const declared = (data as { config?: Record<string, unknown> | null }).config?.first_period_start;
  if (typeof declared === "string" && /^\d{4}-\d{2}-\d{2}$/.test(declared)) return declared;
  return null;
}

/** The ids of every active excise rate belonging to this authority. */
async function fetchRateIds(sb: SupabaseClient, partyKey: string): Promise<string[]> {
  const { data, error } = await sb
    .from("tax_rates")
    .select("id")
    .eq("category", "excise")
    .eq("party_key", partyKey)
    .eq("is_active", true);
  if (error) throw new Error(error.message);
  return ((data ?? []) as { id: string }[]).map((r) => r.id);
}

/**
 * Excise recorded against shipments in `(floor, periodEnd]`, in cents.
 *
 * Each `amount_usd` was snapped to whole cents when it was written, so
 * rounding per row and summing is exact -- unlike summing the dollars and
 * rounding once, which reintroduces a fraction the stored figures do not have.
 *
 * `created_at` is the ship date, the event excise attaches to, and shipment
 * rows are not restated afterwards. So this answers honestly about a closed
 * month, which is why the provider does not set `dependsOnCurrentState`.
 */
async function fetchExciseCents(
  sb: SupabaseClient,
  opts: { rateIds: string[]; channels: ReadonlySet<string>; floor: string | null; periodEnd: string },
): Promise<number> {
  if (opts.rateIds.length === 0) return 0;

  const rows = await fetchAllRows<{ amount_usd: number | string | null }>(() => {
    let q = sb
      .from("export_transaction_taxes")
      .select("amount_usd, export_transactions!inner(created_at, channel)")
      .in("excise_tax_rate_id", opts.rateIds)
      .in("export_transactions.channel", [...opts.channels])
      .lt("export_transactions.created_at", `${addDaysStr(opts.periodEnd, 1)}T00:00:00Z`)
      .order("id", { ascending: true });
    if (opts.floor) q = q.gte("export_transactions.created_at", `${opts.floor}T00:00:00Z`);
    return q;
  });

  let cents = 0;
  for (const row of rows) {
    const usd = Number(row.amount_usd ?? 0);
    if (Number.isFinite(usd)) cents += Math.round(usd * 100);
  }
  return cents;
}

/** Builds the provider for one authority. Identical logic; only the declaration differs. */
function exciseAccrualProvider(
  key: string,
  label: string,
  accountNumber: string,
  authority: ExciseAuthority,
): BalanceProvider {
  return {
    key,
    label,
    kind: "derived",
    appliesTo: (coa) => coa.accountNumber === accountNumber,
    async compute(ctx: BalanceContext): Promise<number | null> {
      const declaredStart = await sharedRead(ctx, `${key}:declaredStart`, () =>
        fetchDeclaredStart(ctx.supabase, authority.filingKey),
      );
      // No active schedule means nobody has declared this obligation exists.
      // Unsourced, not a stated zero.
      if (declaredStart === undefined) return null;
      // A month that closed before the declared first filing period has no
      // accrual to state, and must not acquire one retroactively.
      if (declaredStart !== null && ctx.periodEnd < declaredStart) return null;

      const rateIds = await sharedRead(ctx, `${key}:rateIds`, () => fetchRateIds(ctx.supabase, authority.partyKey));
      // An authority with no active excise rate cannot be accrued at all --
      // that is a missing configuration, not a zero balance.
      if (rateIds.length === 0) return null;

      const cents = await sharedRead(ctx, `${key}:cents:${ctx.periodEnd}`, () =>
        fetchExciseCents(ctx.supabase, {
          rateIds,
          channels: authority.taxableChannels,
          floor: declaredStart,
          periodEnd: ctx.periodEnd,
        }),
      );

      // Nothing shipped yet is a real "no answer", not a stated zero -- same
      // guard as taxAccrual and tipAccrual.
      if (cents <= 0) return null;
      // Liability account: internal convention is negative.
      return -cents;
    },
  };
}

/**
 * Federal excise on GL 2260. Every channel is a taxable federal removal --
 * 26 U.S.C. 5054 taxes beer when it leaves the brewery, whoever buys it.
 */
export const ttbExciseAccrual = exciseAccrualProvider(
  "ttbExciseAccrual",
  "Federal excise accrued",
  "2260",
  { partyKey: "federal_ttb", filingKey: "ttb_beer_excise", taxableChannels: TTB_TAXABLE_CHANNELS },
);

/**
 * NC excise on GL 2220, which is an AGENCY payable ("North Carolina Department
 * of Revenue Payable") and therefore holds beer excise alongside the sales tax
 * `taxAccrual` books. Wholesale is excluded: the wholesaler remits that tax.
 */
export const ncExciseAccrual = exciseAccrualProvider(
  "ncExciseAccrual",
  "NC excise accrued",
  "2220",
  { partyKey: "nc_dor", filingKey: "nc_dor_beer_excise", taxableChannels: NC_TAXABLE_CHANNELS },
);

registerProvider(ttbExciseAccrual);
registerProvider(ncExciseAccrual);
