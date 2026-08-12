/**
 * Summing the manual entries of kind "flow" coded to one account, through a
 * period end.
 *
 * ── Why this is shared rather than copied ────────────────────────────────────
 * Two providers need it and they must agree to the cent. `transactionPostings`
 * counts hand-typed movements alongside the feeds; `manualCorrections` counts
 * them where there is no feed to sit alongside. If those two ever prorated a
 * part-month differently, GL 2220 and GL 2410 would disagree about what the
 * same entry was worth, and nothing on either screen would say why.
 *
 * ── Prorated the same way the P&L prorates it ────────────────────────────────
 * Summed month by month through `periodEnd` using the very function
 * buildFinancials uses (proratedManualAdjustment), rather than a direct overlap
 * formula that would round differently. One entry therefore means the same
 * thing on both statements, down to the cent -- which is the entire reason to
 * reuse it rather than reimplement it.
 *
 * SIGN: amount_cents is already stored in the internal sign convention -- a
 * negative flow is a legitimate correction, and a credit-side account's entries
 * are stored negative (see manualEntries.ts's SIGN CONVENTION). So it is passed
 * through rather than run through normalizeSignedCents, which would re-derive a
 * sign the operator already chose. Same rule manualBalance follows.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { proratedManualAdjustment } from "@/lib/finance/financials/manualNetSales";

/** "YYYY-MM" of the earliest entry start. */
function earliestMonth(entries: { startDate: string }[]): string {
  return entries.reduce((min, e) => (e.startDate < min ? e.startDate : min), entries[0].startDate).slice(0, 7);
}

/** Every "YYYY-MM" from `from` through `to`, inclusive. Empty when `from` is after `to`. */
function monthsThrough(from: string, to: string): string[] {
  const out: string[] = [];
  let [year, month] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
  while (`${year}-${String(month).padStart(2, "0")}` <= to) {
    out.push(`${year}-${String(month).padStart(2, "0")}`);
    if (++month > 12) { month = 1; year += 1; }
  }
  return out;
}

/**
 * Every "flow" entry on `coaId` starting on or before `periodEnd`, prorated and
 * summed. `count` is the number of usable entries, which is how a caller tells
 * "nothing was entered" (null-worthy) from "what was entered comes to zero".
 */
export async function sumManualFlowEntries(
  supabase: SupabaseClient,
  coaId: string,
  periodEnd: string,
): Promise<{ sum: number; count: number }> {
  const rows = await fetchAllRows<{ id: string; start_date: string | null; end_date: string | null; amount_cents: number | null }>(() =>
    supabase
      .from("manual_entries")
      .select("id, start_date, end_date, amount_cents")
      .eq("entry_kind", "flow")
      .eq("chart_of_accounts_id", coaId)
      .lte("start_date", periodEnd)
      .order("id", { ascending: true }),
  );

  const entries = rows
    .filter((r): r is { id: string; start_date: string; end_date: string; amount_cents: number } =>
      Boolean(r.start_date) && Boolean(r.end_date) && r.amount_cents !== null)
    .map((r) => ({ id: r.id, startDate: r.start_date, endDate: r.end_date, amountCents: r.amount_cents, chartOfAccountsId: coaId }));
  if (entries.length === 0) return { sum: 0, count: 0 };

  let sum = 0;
  for (const month of monthsThrough(earliestMonth(entries), periodEnd.slice(0, 7))) {
    sum += proratedManualAdjustment(entries, month).cents;
  }
  return { sum, count: entries.length };
}
