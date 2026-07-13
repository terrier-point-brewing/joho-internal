#!/usr/bin/env -S node --import tsx --env-file=.env.local
/**
 * One-shot backfill — re-sync all June 2026 Square orders into
 * square_orders / pos_line_items (and refunds), then auto-map GL accounts.
 *
 * Uses the exact same idempotent production path as the "Sync from Square"
 * button / finance-sync cron (syncPosTransactionsForRange), so re-running is
 * safe: present orders refresh in place, missing orders get inserted.
 *
 * Root cause (see scripts/diagnose-june-sync-gap.ts): the near-real-time Square
 * webhook stopped landing orders from 2026-06-14 onward, and the finance-sync
 * safety-net cron did not exist during June (earliest cron_runs entry is
 * 2026-07-08). Its 3-day trailing window now only reaches recent days, so
 * mid/late June was permanently stranded until this manual full-month re-sync.
 *
 * Run: npx tsx --env-file=.env.local scripts/backfill-june-2026-pos.ts
 */
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { syncSquareOrders } from "@/lib/finance/syncPosTransactions";
import { syncRefunds } from "@/lib/finance/syncRefunds";
import { autoMapPosLineItems } from "@/lib/finance/autoMap";
import { squarePostAll, squareGetAll, squareLocationId } from "@/lib/square/client";
import { dayRangeUtc, BREWERY_TZ } from "@/lib/utils/datetime";
import type { Order } from "@/types/square";
import type { SquareRefund } from "@/lib/square/refunds";

const START = "2026-06-01";
const END = "2026-06-30";

// Bypass the unstable_cache-wrapped fetchCompletedOrders/fetchRefunds (they need
// a Next.js request/build context this standalone script doesn't have) by hitting
// the raw client directly — same approach as scripts/financials-parity-square.ts.
async function fetchOrdersByState(states: string[]): Promise<Order[]> {
  const { startUtc, endUtc } = dayRangeUtc(START, END, BREWERY_TZ);
  return squarePostAll<Order>("/orders/search", "orders", {
    location_ids: [squareLocationId()],
    query: {
      filter: {
        date_time_filter: { created_at: { start_at: startUtc, end_at: endUtc } },
        state_filter: { states },
      },
    },
    return_entries: false,
    limit: 500,
  });
}

async function fetchLiveRefunds(): Promise<SquareRefund[]> {
  const { startUtc, endUtc } = dayRangeUtc(START, END, BREWERY_TZ);
  return squareGetAll<SquareRefund>("/refunds", "refunds", {
    begin_time: startUtc,
    end_time: endUtc,
    limit: "100",
  });
}

async function main() {
  const supabase = createSupabaseAdminClient();

  const countPos = async () => {
    const { count, error } = await supabase
      .from("square_orders")
      .select("id", { count: "exact", head: true })
      .is("invoice_id", null)
      .gte("transaction_date", `${START}T00:00:00Z`)
      .lt("transaction_date", `${END}T23:59:59Z`);
    if (error) throw new Error(`count: ${error.message}`);
    return count ?? 0;
  };

  const before = await countPos();
  console.log(`Persisted POS orders for ${START}..${END} BEFORE: ${before}`);

  console.log(`\nFetching live Square orders (COMPLETED + CANCELED) ...`);
  const [completed, canceled] = await Promise.all([
    fetchOrdersByState(["COMPLETED"]),
    fetchOrdersByState(["CANCELED"]),
  ]);
  console.log(`  fetched completed=${completed.length} canceled=${canceled.length}`);

  console.log(`\nSyncing orders (syncSquareOrders core) ...`);
  const orders = await syncSquareOrders(supabase, [...completed, ...canceled]);
  console.log(`  ${JSON.stringify({ synced: orders.synced, total: orders.total, posOrders: orders.posOrders, invoiceOrders: orders.invoiceOrders, canceled: orders.canceled, errors: orders.errors?.length ?? 0 })}`);
  if (orders.errors?.length) for (const e of orders.errors) console.log(`    ERR: ${e}`);

  console.log(`\nSyncing refunds (syncRefunds core) ...`);
  const liveRefunds = await fetchLiveRefunds();
  const refunds = await syncRefunds(supabase, liveRefunds);
  console.log(`  fetched=${liveRefunds.length} ${JSON.stringify(refunds)}`);

  console.log(`\nAuto-mapping POS line items (year 2026) ...`);
  const mapped = await autoMapPosLineItems(supabase, { year: 2026 });
  console.log(`  ${JSON.stringify(mapped)}`);

  const after = await countPos();
  console.log(`\nPersisted POS orders for ${START}..${END} AFTER: ${after}  (added ${after - before})`);

  // Report unmapped POS line items remaining in June (data-quality visibility).
  const { data: junOrders } = await supabase
    .from("square_orders")
    .select("id")
    .is("invoice_id", null)
    .gte("transaction_date", `${START}T00:00:00Z`)
    .lt("transaction_date", `${END}T23:59:59Z`);
  const ids = (junOrders ?? []).map((o) => o.id);
  let unmapped = 0;
  let total = 0;
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const { count: c } = await supabase
      .from("pos_line_items")
      .select("id", { count: "exact", head: true })
      .in("order_id", chunk);
    total += c ?? 0;
    const { count: u } = await supabase
      .from("pos_line_items")
      .select("id", { count: "exact", head: true })
      .is("chart_of_accounts_id", null)
      .not("square_variation_id", "is", null)
      .in("order_id", chunk);
    unmapped += u ?? 0;
  }
  console.log(`\nJune pos_line_items: total=${total}  unmapped(has variation, no CoA)=${unmapped}`);
}

main().then(() => process.exit(0), (e) => { console.error("FATAL:", e); process.exit(1); });
