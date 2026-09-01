/**
 * Persists Square processing fees (lib/square/paymentFees.ts) into
 * square_payment_fees, where the statements read them.
 *
 * Runs inside the finance sync's trailing window each night. The FIRST run —
 * an empty table — walks back to the earliest stored Square order instead, so
 * history fills itself in without a separate backfill ceremony; the same
 * first-run-walks-history arrangement the Plaid transaction feed uses. Fees
 * can post to a payment up to a day late, so the nightly window re-walk is
 * what corrects a fee that was 0 when first seen.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchPaymentFees } from "@/lib/square/paymentFees";
import { chunk } from "@/lib/utils/chunk";

export async function syncSquareFeesForRange(
  supabase: SupabaseClient,
  startDate: string,
  endDate: string,
): Promise<{ upserted: number; from: string }> {
  let from = startDate;

  const { count, error: countErr } = await supabase
    .from("square_payment_fees")
    .select("payment_id", { count: "exact", head: true });
  if (countErr) throw new Error(`Count square fees failed: ${countErr.message}`);

  if ((count ?? 0) === 0) {
    // Empty table: cover everything the orders feed covers. The earliest
    // order's date is the honest inception — asking Square for time before the
    // account existed costs pages and returns nothing.
    const { data: firstOrder, error: firstErr } = await supabase
      .from("square_orders")
      .select("transaction_date")
      .order("transaction_date", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (firstErr) throw new Error(`Find first Square order failed: ${firstErr.message}`);
    const firstDate = (firstOrder?.transaction_date as string | undefined)?.slice(0, 10);
    if (firstDate && firstDate < from) from = firstDate;
  }

  const fees = await fetchPaymentFees(from, endDate);

  let upserted = 0;
  for (const rows of chunk(fees, 500)) {
    const { error } = await supabase.from("square_payment_fees").upsert(
      rows.map((f) => ({
        payment_id: f.paymentId,
        payment_date: f.paymentDate,
        fee_cents: f.feeCents,
        total_cents: f.totalCents,
        synced_at: new Date().toISOString(),
      })),
      { onConflict: "payment_id" },
    );
    if (error) throw new Error(`Upsert square fees failed: ${error.message}`);
    upserted += rows.length;
  }

  return { upserted, from };
}
