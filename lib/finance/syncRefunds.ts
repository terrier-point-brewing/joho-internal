/**
 * Square sales refunds → finance (`square_refunds`).
 *
 * Refunds do NOT change a Square order's state (a fully refunded order stays
 * COMPLETED), so the order sync in syncPosTransactions.ts is structurally blind
 * to them. Refunds arrive as separate `refund.*` webhook events (or are pulled
 * for a date range) and are persisted here, then netted against revenue on the
 * financial statements via a single contra-revenue chart-of-accounts account.
 *
 * Idempotent per `square_refund_id`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SquareRefund } from "@/lib/square/refunds";
import { fetchRefunds } from "@/lib/square/refunds";
import { fetchOrdersByIds } from "@/lib/square/orders";
import { resolveSourceOrderIds } from "@/lib/square/returnOrders";
import { fetchOrderLinesByOrder, fetchRefundRoutingRules, resolveRefundAccount } from "./refundRouting";

/** Name of the app-managed contra-revenue account (seeded by migration). */
export const REFUNDS_CONTRA_ACCOUNT_NAME = "Sales Returns & Refunds";

export interface RefundSyncResult {
  synced: number;
  total: number;
  errors?: string[];
}

/** Square refund shape as it arrives inside a `refund.*` webhook payload. */
export interface RefundLike {
  id: string;
  order_id?: string | null;
  payment_id?: string | null;
  amount_money?: { amount?: number; currency?: string } | null;
  status?: string | null;
  reason?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface NormalizedRefund {
  squareRefundId: string;
  squareOrderId: string | null;
  squarePaymentId: string | null;
  amountCents: number;
  currency: string;
  status: string | null;
  reason: string | null;
  refundedAt: string | null;
  raw: object;
}

/** Normalize a Square refund (list API or webhook payload) into our shape. Pure. */
export function normalizeRefund(refund: RefundLike): NormalizedRefund {
  return {
    squareRefundId: refund.id,
    squareOrderId: refund.order_id ?? null,
    squarePaymentId: refund.payment_id ?? null,
    amountCents: refund.amount_money?.amount ?? 0,
    currency: refund.amount_money?.currency ?? "USD",
    status: refund.status ?? null,
    reason: refund.reason ?? null,
    // Square sends created_at on refund.created and updated_at on refund.updated;
    // prefer the latter so a status change (PENDING → COMPLETED) advances the time.
    refundedAt: refund.updated_at ?? refund.created_at ?? null,
    raw: refund as object,
  };
}

/** Build the `square_refunds` upsert row. Pure. `updated_at` is the trigger's job. */
export function buildRefundRow(
  n: NormalizedRefund,
  orderDbId: string | null,
  coaId: string | null,
) {
  return {
    square_refund_id: n.squareRefundId,
    square_order_id: n.squareOrderId,
    square_payment_id: n.squarePaymentId,
    order_id: orderDbId,
    amount_cents: n.amountCents,
    currency: n.currency,
    status: n.status,
    reason: n.reason,
    refunded_at: n.refundedAt,
    chart_of_accounts_id: coaId,
    raw_data: n.raw,
  };
}

/** Resolve the contra-revenue account id refunds net against (null if absent). */
async function resolveContraCoaId(supabase: SupabaseClient): Promise<string | null> {
  const { data } = await supabase
    .from("chart_of_accounts")
    .select("id")
    .eq("account_name", REFUNDS_CONTRA_ACCOUNT_NAME)
    .maybeSingle();
  return data?.id ?? null;
}

/**
 * Core: persist a set of Square refunds into `square_refunds`, resolving each to
 * its `square_orders` db id and the shared contra-revenue account.
 */
export async function syncRefunds(
  supabase: SupabaseClient,
  refunds: RefundLike[],
): Promise<RefundSyncResult> {
  if (refunds.length === 0) return { synced: 0, total: 0 };

  const normalized = refunds.map(normalizeRefund);
  const coaId = await resolveContraCoaId(supabase);

  // A refund's order_id is the *return order* Square creates for it, not the
  // sale — the return order has no line items; the goods live under its
  // returns[].source_order_id. Repoint each refund at the sale it reverses so
  // square_order_id / order_id drill through to what was actually sold. The
  // return-order id is preserved in raw_data.order_id. Refunds that already
  // point at a sale (no return order) are left unchanged. See resolveSourceOrderIds.
  const returnOrderIds = [...new Set(normalized.map((n) => n.squareOrderId).filter((id): id is string => !!id))];
  const saleByReturn = returnOrderIds.length
    ? resolveSourceOrderIds(await fetchOrdersByIds(returnOrderIds))
    : new Map<string, string>();
  for (const n of normalized) {
    if (n.squareOrderId) n.squareOrderId = saleByReturn.get(n.squareOrderId) ?? n.squareOrderId;
  }

  // Map Square order ids → square_orders db ids so refunds link to their order.
  const orderIds = [...new Set(normalized.map((n) => n.squareOrderId).filter((id): id is string => !!id))];
  const orderDbIdBysquare = new Map<string, string>();
  if (orderIds.length > 0) {
    const { data } = await supabase
      .from("square_orders")
      .select("id, square_order_id")
      .in("square_order_id", orderIds);
    for (const row of data ?? []) orderDbIdBysquare.set(row.square_order_id, row.id);
  }

  // Link the refund to the invoice it was raised against, when there is one.
  // This is what makes an invoice refund someone issued in the Square dashboard
  // show up as "needs a reason" (reason_code null + invoice_id set) instead of
  // disappearing into the contra account unexplained. Taproom POS refunds match
  // nothing here and stay invoice-less, which is correct — there is no invoice
  // and nothing for a human to decide.
  const invoiceIdByOrder = new Map<string, string>();
  if (orderIds.length > 0) {
    const { data } = await supabase
      .from("invoices")
      .select("id, raw_data->>square_order_id")
      .in("raw_data->>square_order_id", orderIds);
    for (const row of (data ?? []) as { id: string; square_order_id: string | null }[]) {
      if (row.square_order_id) invoiceIdByOrder.set(row.square_order_id, row.id);
    }
  }

  // Where each refund actually posts. The contra account is the default, not
  // the answer: a refund of something that was never revenue — a returnable keg
  // or pump deposit coded to GL 2420 — has to settle the liability it created
  // instead of netting against sales. See refundRouting.ts for why the match
  // has to be exact, and why an ambiguous one stays on contra-revenue.
  const routingRules = await fetchRefundRoutingRules(supabase);
  const orderLinesByOrder = routingRules.size > 0
    ? await fetchOrderLinesByOrder(
        supabase,
        normalized
          .map((n) => (n.squareOrderId ? orderDbIdBysquare.get(n.squareOrderId) ?? null : null))
          .filter((id): id is string => !!id),
      )
    : new Map();

  const rows = normalized.map((n) => {
    const orderDbId = n.squareOrderId ? orderDbIdBysquare.get(n.squareOrderId) ?? null : null;
    const routedCoaId = resolveRefundAccount(
      n.amountCents,
      orderDbId ? orderLinesByOrder.get(orderDbId) ?? [] : [],
      routingRules,
      coaId,
    );
    return {
      ...buildRefundRow(n, orderDbId, routedCoaId),
      // `origin` and `reason_code` are deliberately absent: the upsert writes only
      // the columns it names, so a refund the app issued keeps its reason and its
      // line detail when this sync sees the webhook it just caused.
      ...(n.squareOrderId && invoiceIdByOrder.has(n.squareOrderId)
        ? { invoice_id: invoiceIdByOrder.get(n.squareOrderId) }
        : {}),
    };
  });

  const errors: string[] = [];
  let synced = 0;
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const { data, error } = await supabase
      .from("square_refunds")
      .upsert(rows.slice(i, i + BATCH), { onConflict: "square_refund_id" })
      .select("id");
    if (error) {
      errors.push(`Refund upsert ${i}: ${error.message}`);
      continue;
    }
    synced += data?.length ?? 0;
  }

  return { synced, total: rows.length, errors: errors.length ? errors : undefined };
}

/** Date-window backfill — used by the manual sync route and the daily cron. */
export async function syncRefundsForRange(
  supabase: SupabaseClient,
  startDate: string,
  endDate: string,
): Promise<RefundSyncResult> {
  const refunds: SquareRefund[] = await fetchRefunds(startDate, endDate);
  return syncRefunds(supabase, refunds);
}
