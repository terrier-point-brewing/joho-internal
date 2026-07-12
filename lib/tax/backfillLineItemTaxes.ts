/**
 * Backfill `pos_line_item_taxes` for POS orders already stored in
 * `square_orders` / `pos_line_items`, by re-fetching each order from Square
 * and rebuilding its tax rows via `buildLineItemTaxRows` (the same pure
 * mapper the live sync uses — see lib/finance/syncPosTransactions.ts). Used
 * to derive tax rows for orders synced before `pos_line_item_taxes` existed,
 * or to re-derive them if the mapping logic changes.
 *
 * Idempotent per order: for each order's already-stored line items, deletes
 * any existing `pos_line_item_taxes` rows for those line ids, then inserts
 * the freshly rebuilt rows. Re-running the same range is a no-op beyond the
 * delete+reinsert.
 *
 * `fetchOrders` is injectable (defaults to `fetchOrdersByIds`, which batches
 * internally up to 100/call) so this stays pure DB+Square orchestration and
 * is fully testable with a stubbed client + stubbed fetch — no real DB or
 * Square calls in tests.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Order } from "@/types/square";
import { fetchOrdersByIds } from "@/lib/square/orders";
import { buildLineItemTaxRows } from "@/lib/finance/syncPosTransactions";

const BATCH_SIZE = 100;
// PostgREST default max rows per response — queries that can exceed it must
// page via range() or they silently truncate.
const PAGE_SIZE = 1000;

export interface BackfillLineItemTaxesResult {
  orders: number;
  taxRows: number;
  errors?: string[];
}

interface SquareOrderRow {
  id: string;
  square_order_id: string;
}

interface PosLineItemRow {
  id: string;
  order_id: string;
  square_line_item_uid: string | null;
}

export async function backfillLineItemTaxesForRange(
  supabase: SupabaseClient,
  startDate: string,
  endDate: string,
  fetchOrders: (orderIds: string[]) => Promise<Order[]> = fetchOrdersByIds,
  pageSize: number = PAGE_SIZE,
): Promise<BackfillLineItemTaxesResult> {
  // Only POS orders carry pos_line_items — invoice-backed orders use
  // invoice_line_items instead, so restrict to those up front.
  //
  // PostgREST caps a single select at ~1000 rows, so both this query and the
  // pos_line_items query below MUST page via range() — otherwise a busy range
  // (>1000 orders, or >1000 lines in an order chunk) is silently truncated and
  // those orders/lines get no tax rows. Order by a stable key so paging is
  // deterministic.
  const dbOrders: SquareOrderRow[] = [];
  for (let page = 0; ; page++) {
    const from = page * pageSize;
    const { data, error } = await supabase
      .from("square_orders")
      .select("id, square_order_id")
      .gte("transaction_date", startDate)
      .lt("transaction_date", endDate)
      .is("invoice_id", null)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as SquareOrderRow[];
    dbOrders.push(...rows);
    if (rows.length < pageSize) break;
  }

  if (dbOrders.length === 0) return { orders: 0, taxRows: 0 };

  const dbIdBySquareOrderId = new Map(dbOrders.map((o) => [o.square_order_id, o.id]));
  const dbIds = dbOrders.map((o) => o.id);

  // Stored line items, grouped per order db id and keyed by the Square line
  // uid — uids are only unique within one order, so the map must be scoped
  // per order (mirrors syncSquareOrders' lineItemDbIdByUidByOrderDbId). The
  // order-id IN list is chunked to bound URL length; each chunk is then paged
  // so a chunk with >1000 line items isn't truncated.
  const lineItemDbIdByUidByOrderDbId = new Map<string, Map<string, string>>();
  for (let i = 0; i < dbIds.length; i += BATCH_SIZE) {
    const chunk = dbIds.slice(i, i + BATCH_SIZE);
    for (let page = 0; ; page++) {
      const from = page * pageSize;
      const { data: lineRows, error: lineErr } = await supabase
        .from("pos_line_items")
        .select("id, order_id, square_line_item_uid")
        .in("order_id", chunk)
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1);
      if (lineErr) throw new Error(lineErr.message);
      const rows = (lineRows ?? []) as PosLineItemRow[];
      for (const row of rows) {
        if (!row.square_line_item_uid) continue;
        let uidMap = lineItemDbIdByUidByOrderDbId.get(row.order_id);
        if (!uidMap) {
          uidMap = new Map();
          lineItemDbIdByUidByOrderDbId.set(row.order_id, uidMap);
        }
        uidMap.set(row.square_line_item_uid, row.id);
      }
      if (rows.length < pageSize) break;
    }
  }

  const squareOrders = await fetchOrders(dbOrders.map((o) => o.square_order_id));

  const errors: string[] = [];
  let ordersProcessed = 0;
  let taxRows = 0;

  for (const order of squareOrders) {
    const orderDbId = dbIdBySquareOrderId.get(order.id);
    if (!orderDbId) continue;
    const uidMap = lineItemDbIdByUidByOrderDbId.get(orderDbId);
    if (!uidMap || uidMap.size === 0) continue;

    const rows = buildLineItemTaxRows(order, uidMap);
    const lineItemIds = Array.from(uidMap.values());

    // Idempotent rebuild: clear stale tax rows for this order's lines before
    // inserting the freshly derived set.
    const { error: delErr } = await supabase
      .from("pos_line_item_taxes")
      .delete()
      .in("line_item_id", lineItemIds);
    if (delErr) {
      errors.push(`Delete for order ${order.id}: ${delErr.message}`);
      continue;
    }

    if (rows.length > 0) {
      const { error: insErr } = await supabase.from("pos_line_item_taxes").insert(rows);
      if (insErr) {
        errors.push(`Insert for order ${order.id}: ${insErr.message}`);
        continue;
      }
    }

    ordersProcessed++;
    taxRows += rows.length;
  }

  return { orders: ordersProcessed, taxRows, errors: errors.length ? errors : undefined };
}
