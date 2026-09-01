/**
 * Square processing fees, as the statements read them.
 *
 * ── The cost that vanished between two feeds ─────────────────────────────────
 * The P&L counts a sale at its net-sales value; Square deducts its fee before
 * the money reaches the stored balance. Cash was honest, the P&L was not:
 * roughly $700–900 a month of real cost appeared on neither statement, and it
 * was the second-largest piece of the balancing difference after the CBC
 * transition items (hunted down 2026-08-31).
 *
 * ── Unlike depreciation, this is CASH ────────────────────────────────────────
 * Depreciation and inventory relief are non-cash and inject into the P&L
 * alone. A processing fee is money genuinely gone — withheld at source — so
 * its row belongs on the P&L AND the cash-flow statement, and fetchSources
 * supplies it for both. Retained earnings absorbs the same cumulative figure.
 *
 * ── Where the account comes from ─────────────────────────────────────────────
 * The squareStoredBalance method's optional `processingFeesCoaId` setup field
 * (GL 1040's source config) — the same arrangement as inventoryOnHand's COGS
 * offset: the method that owns the money names where its derived P&L row
 * lands, and an operator who has not named an account keeps today's behaviour.
 *
 * Must not import from lib/finance/balances (statement isolation).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { monthEnd } from "@/lib/finance/manualEntries";

/** Config key on the squareStoredBalance source row. Declared by the method's setup field; read here by the same name. */
export const PROCESSING_FEES_KEY = "processingFeesCoaId";

export interface SquareFeeSeries {
  /** The expense account the fee rows post to. */
  coaId: string;
  /** "YYYY-MM" → fee cents that month, POSITIVE (the injection negates). Months with no fees absent. */
  feeCentsByMonth: Record<string, number>;
}

/** The configured fee account, or null while the operator has not named one. */
export async function fetchSquareFeeAccount(supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase
    .from("balance_sheet_account_sources")
    .select("config")
    .eq("provider_key", "squareStoredBalance")
    .eq("active", true);
  if (error) throw new Error(`Load Square source config failed: ${error.message}`);
  for (const row of data ?? []) {
    const value = ((row.config ?? {}) as Record<string, unknown>)[PROCESSING_FEES_KEY];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * Monthly fee totals through the LAST month of `months`. Null when no account
 * is configured — the feature off, not an empty month.
 */
export async function fetchSquareFeeSeries(
  supabase: SupabaseClient,
  months: string[],
): Promise<SquareFeeSeries | null> {
  if (months.length === 0) return null;
  const coaId = await fetchSquareFeeAccount(supabase);
  if (!coaId) return null;

  const last = months[months.length - 1];
  const rows = await fetchAllRows<{ payment_date: string; fee_cents: number | null }>(() =>
    supabase
      .from("square_payment_fees")
      .select("payment_date, fee_cents")
      .gt("fee_cents", 0)
      .lte("payment_date", monthEnd(`${last}-01`))
      .order("payment_id", { ascending: true }),
  );

  const feeCentsByMonth: Record<string, number> = {};
  for (const r of rows) {
    const month = r.payment_date.slice(0, 7);
    feeCentsByMonth[month] = (feeCentsByMonth[month] ?? 0) + (r.fee_cents ?? 0);
  }
  return { coaId, feeCentsByMonth };
}

/** Cumulative fees through `month`, internal P&L convention (negative — a cost). Retained earnings' share. */
export async function cumulativeSquareFeesThrough(supabase: SupabaseClient, month: string): Promise<number> {
  const series = await fetchSquareFeeSeries(supabase, [month]);
  if (!series) return 0;
  let sum = 0;
  for (const [m, cents] of Object.entries(series.feeCentsByMonth)) {
    if (m <= month) sum -= cents;
  }
  return sum;
}
