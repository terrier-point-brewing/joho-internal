/**
 * Excise tax expense, as the statements read it.
 *
 * ── The cost that had a liability but no P&L ─────────────────────────────────
 * Every shipment writes its excise into `export_transaction_taxes`, and the
 * balance sheet accrues the liability from those rows (GL 2220 / GL 2260 via
 * balances/providers/exciseAccruals.ts). The P&L never recognized the expense
 * side: $9,430.12 of accrued excise with no income-statement counterpart was
 * the largest single piece of the balancing difference after the 2026-08-31
 * hunt. This module is the expense half, derived from the SAME rows, routed
 * the SAME way (by `excise_tax_rate_id`, never `tax_name`), floored by the
 * SAME declared first filing period — one formula, read by both sides.
 *
 * The authority configs and row-sum live HERE, and the accrual providers
 * import them, so the liability and the expense cannot drift apart.
 *
 * ── Non-cash, P&L only ───────────────────────────────────────────────────────
 * An excise accrual is money not yet gone — payments post to the liability
 * account when they happen. So the derived row reaches the P&L alone, exactly
 * like depreciation, and never the cash-flow statement. Retained earnings
 * absorbs the same cumulative figure (balances/providers/retainedEarnings.ts).
 *
 * Must not import from lib/finance/balances (statement isolation).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { addDaysStr } from "@/lib/utils/datetime";
import { monthEnd } from "@/lib/finance/manualEntries";
import { TAXABLE_CHANNELS as NC_TAXABLE_CHANNELS } from "@/lib/tax/parties/ncDorBeerExcise/rates";
import { TTB_TAXABLE_CHANNELS } from "@/lib/tax/parties/ttbBeerExcise/rates";

/** The P&L account the derived expense rows post to: 6451 "Barrel Excise Taxes Paid". */
export const EXCISE_EXPENSE_ACCOUNT_NUMBER = "6451";

/** What one authority needs in order to be accrued (or expensed — same rows). */
export interface ExciseAuthority {
  /** `tax_rates.party_key` — which authority its excise rates are owed to. */
  partyKey: string;
  /** `tax_schedules.filing_key` — the schedule whose declared first period floors the accrual. */
  filingKey: string;
  /** Shipment channels this authority actually taxes. */
  taxableChannels: ReadonlySet<string>;
}

/**
 * Both authorities, exactly as the accrual providers declare them. Federal
 * taxes every removal (26 U.S.C. 5054); North Carolina excludes wholesale
 * because the wholesaler remits it (Form B-C-710 Line 4a).
 */
export const EXCISE_AUTHORITIES: Record<"ttb" | "nc", ExciseAuthority> = {
  ttb: { partyKey: "federal_ttb", filingKey: "ttb_beer_excise", taxableChannels: TTB_TAXABLE_CHANNELS },
  nc: { partyKey: "nc_dor", filingKey: "nc_dor_beer_excise", taxableChannels: NC_TAXABLE_CHANNELS },
};

/**
 * The first date this authority's excise may be accrued from, or null for no
 * floor. Distinguishes "no schedule" (undefined — the obligation does not
 * exist) from "schedule with no declared first period" (null — accrue
 * everything). See exciseAccruals.ts's header for why the fallback is NOT the
 * schedule row's created_at.
 */
export async function fetchDeclaredStart(sb: SupabaseClient, filingKey: string): Promise<string | null | undefined> {
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
export async function fetchRateIds(sb: SupabaseClient, partyKey: string): Promise<string[]> {
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
 * Excise recorded against shipments in `(floor, end of throughMonth]`, in
 * cents, grouped by the shipment's month ("YYYY-MM").
 *
 * Each `amount_usd` was snapped to whole cents when written, so rounding per
 * row and summing is exact. `created_at` is the ship date — the event excise
 * attaches to — and shipment rows are not restated afterwards, so a closed
 * month's figure is stable.
 */
export async function fetchExciseCentsByMonth(
  sb: SupabaseClient,
  opts: { rateIds: string[]; channels: ReadonlySet<string>; floor: string | null; throughMonth: string },
): Promise<Record<string, number>> {
  if (opts.rateIds.length === 0) return {};
  const periodEnd = monthEnd(`${opts.throughMonth}-01`);

  const rows = await fetchAllRows<{ amount_usd: number | string | null; export_transactions: { created_at: string } }>(() => {
    let q = sb
      .from("export_transaction_taxes")
      .select("amount_usd, export_transactions!inner(created_at, channel)")
      .in("excise_tax_rate_id", opts.rateIds)
      .in("export_transactions.channel", [...opts.channels])
      .lt("export_transactions.created_at", `${addDaysStr(periodEnd, 1)}T00:00:00Z`)
      .order("id", { ascending: true });
    if (opts.floor) q = q.gte("export_transactions.created_at", `${opts.floor}T00:00:00Z`);
    return q;
  });

  const byMonth: Record<string, number> = {};
  for (const row of rows) {
    const usd = Number(row.amount_usd ?? 0);
    if (!Number.isFinite(usd)) continue;
    const month = row.export_transactions?.created_at?.slice(0, 7);
    if (!month) continue;
    byMonth[month] = (byMonth[month] ?? 0) + Math.round(usd * 100);
  }
  return byMonth;
}

/**
 * Both authorities' excise per month through `throughMonth`, POSITIVE cents
 * (the P&L injection negates). An authority with no active schedule or no
 * active rates contributes nothing — the obligation is undeclared, exactly the
 * condition under which its accrual provider returns null.
 */
export async function fetchExciseExpenseByMonth(sb: SupabaseClient, throughMonth: string): Promise<Record<string, number>> {
  const combined: Record<string, number> = {};
  for (const authority of Object.values(EXCISE_AUTHORITIES)) {
    const declaredStart = await fetchDeclaredStart(sb, authority.filingKey);
    if (declaredStart === undefined) continue;
    const rateIds = await fetchRateIds(sb, authority.partyKey);
    if (rateIds.length === 0) continue;
    const byMonth = await fetchExciseCentsByMonth(sb, {
      rateIds,
      channels: authority.taxableChannels,
      floor: declaredStart,
      throughMonth,
    });
    for (const [month, cents] of Object.entries(byMonth)) {
      combined[month] = (combined[month] ?? 0) + cents;
    }
  }
  return combined;
}

/** Cumulative excise through `month`, internal P&L convention (negative — a cost). Retained earnings' share. */
export async function cumulativeExciseExpenseThrough(sb: SupabaseClient, month: string): Promise<number> {
  const byMonth = await fetchExciseExpenseByMonth(sb, month);
  let sum = 0;
  for (const [m, cents] of Object.entries(byMonth)) {
    if (m <= month) sum -= cents;
  }
  return sum;
}
