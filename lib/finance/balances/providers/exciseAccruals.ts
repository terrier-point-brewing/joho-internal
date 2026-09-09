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
// The authority configs and the row-sum live in lib/finance/exciseExpense.ts,
// shared with the P&L's derived expense row, so the liability accrued here and
// the expense the income statement recognizes are ONE formula, not two that
// agree today. This provider adds only the balance-sheet framing: the
// null-vs-zero guards and the internal sign convention.
import { fetchDeclaredStart, fetchExciseCentsByMonth, fetchRateIds, EXCISE_AUTHORITIES } from "@/lib/finance/exciseExpense";
import type { ExciseAuthority } from "@/lib/finance/exciseExpense";
import { registerProvider, sharedRead } from "../registry";
import type { BalanceContext, BalanceProvider } from "../registry";

/**
 * Excise recorded against shipments in `(floor, periodEnd]`, in cents.
 * `periodEnd` is always a month end, so summing the shared per-month figures
 * through its month is the same bound the row filter applies.
 */
async function fetchExciseCents(
  sb: Parameters<typeof fetchExciseCentsByMonth>[0],
  opts: { rateIds: string[]; channels: ReadonlySet<string>; floor: string | null; periodEnd: string },
): Promise<number> {
  const throughMonth = opts.periodEnd.slice(0, 7);
  const byMonth = await fetchExciseCentsByMonth(sb, {
    rateIds: opts.rateIds,
    channels: opts.channels,
    floor: opts.floor,
    throughMonth,
  });
  let cents = 0;
  for (const [month, monthCents] of Object.entries(byMonth)) {
    if (month <= throughMonth) cents += monthCents;
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
  EXCISE_AUTHORITIES.ttb,
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
  EXCISE_AUTHORITIES.nc,
);

registerProvider(ttbExciseAccrual);
registerProvider(ncExciseAccrual);
