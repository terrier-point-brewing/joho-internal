import { NextRequest, NextResponse, after } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { runTaproomConsumptionSync } from "@/lib/production/taproomConsumptionSync";
import { syncPosOrdersByIds } from "@/lib/finance/syncPosTransactions";
import { syncRefunds } from "@/lib/finance/syncRefunds";
import { reconcileInvoiceStatus } from "@/lib/finance/reconcileInvoiceStatus";
import { syncSquareInvoiceById } from "@/lib/finance/syncSquareInvoices";
import { autoMapInvoiceLineItems } from "@/lib/finance/autoMap";
import {
  verifySquareSignature,
  isFinanceSyncableEvent,
  isRefundEvent,
  isInvoiceEvent,
  extractSquareOrderId,
  extractSquareInvoiceId,
  extractSquareRefund,
} from "@/lib/square/webhook";

export const dynamic = "force-dynamic";
// Give the background reconcile (Square API round-trips) room to finish after we
// respond; Vercel caps this to the plan's max.
export const maxDuration = 60;

/**
 * Square webhook → near-real-time sync on `order.*` events. Two consumers run
 * off the same delivery:
 *
 *  1. Finance transactions — upsert the changed order into `square_orders` /
 *     `pos_line_items` so `finance > transactions` reflects the sale within
 *     seconds instead of only after someone clicks "Sync from Square". Only the
 *     one changed order is refetched (by id), not a whole window.
 *  2. Taproom consumption — run the SAME idempotent reconcile the daily cron
 *     uses over a short window, so a Draft Restock's swap shipment + recount +
 *     shrinkage land immediately.
 *
 * Both are idempotent, and the daily crons stay as safety nets for missed
 * deliveries, so overlapping webhook + cron runs are harmless. A public
 * endpoint: the HMAC signature is the only auth.
 *
 * Env: SQUARE_WEBHOOK_SIGNATURE_KEY (dashboard signature key) and
 * SQUARE_WEBHOOK_URL (the exact notification URL configured in Square — it is
 * part of the signed payload, so it must match character-for-character).
 */
const WINDOW_DAYS = 1;

export async function POST(req: NextRequest) {
  const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  const notificationUrl = process.env.SQUARE_WEBHOOK_URL;
  if (!signatureKey || !notificationUrl) {
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  // Raw body is required for signature verification — read it before parsing.
  const rawBody = await req.text();
  const valid = verifySquareSignature({
    signatureKey,
    notificationUrl,
    rawBody,
    signatureHeader: req.headers.get("x-square-hmacsha256-signature"),
  });
  if (!valid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

  let event: { type?: string; data?: unknown } = {};
  try {
    event = JSON.parse(rawBody) as { type?: string; data?: unknown };
  } catch {
    // A verified-but-unparseable body shouldn't happen; ack so Square stops retrying.
    return NextResponse.json({ ignored: true, reason: "unparseable" });
  }

  // Order and refund events drive a finance sync; order events also drive the
  // taproom reconcile. Ack everything else with 200 so Square doesn't retry
  // non-actionable deliveries.
  const invoiceEvent = isInvoiceEvent(event.type);
  if (!isFinanceSyncableEvent(event.type) && !invoiceEvent) {
    return NextResponse.json({ ignored: true, type: event.type ?? null });
  }

  // Reconcile in the background so Square gets an immediate 200. The full sync
  // makes several Square round-trips and would otherwise blow the gateway timeout
  // (504) — and Square would then retry a delivery we already accepted. It's
  // idempotent per source_ref and the daily cron is the safety net, so a dropped
  // or partial background run self-heals on the next trigger.
  after(async () => {
    const supabase = createSupabaseAdminClient();

    // Invoice events → reconcile that one invoice's status across the ledger,
    // export transactions, and deposit allocations. Separate from order/refund
    // handling below.
    if (invoiceEvent) {
      const invoiceId = extractSquareInvoiceId(event);
      if (invoiceId) {
        try {
          const result = await reconcileInvoiceStatus(supabase, invoiceId);
          console.log("[square-webhook] invoice reconcile", {
            type: event.type,
            invoiceId,
            ledgerStatus: result.ledgerStatus,
            invoiceMissing: result.invoiceMissing ?? false,
            updatedExportTransactions: result.updatedExportTransactions,
            updatedAllocation: result.updatedAllocation,
            paymentCaptured: result.paymentCaptured,
            skipped: result.skippedReason ?? null,
          });
        } catch (e) {
          console.error("[square-webhook] invoice reconcile failed", e);
        }

        // Line items never arrive via webhook — reconcile only covers status. Sync
        // just THIS invoice (idempotent, fill-nulls-only mapping) so its lines land
        // and auto-map without waiting for a manual "Sync from Square" click — and
        // without re-pulling every invoice + a year of orders on each delivery. The
        // description-sibling auto-map pass is Supabase-only (cheap); the daily cron
        // does the full-year sync as the backstop.
        try {
          const syncResult = await syncSquareInvoiceById(supabase, invoiceId);
          const year = new Date().getFullYear();
          const mapResult = await autoMapInvoiceLineItems(supabase, { year });
          console.log("[square-webhook] invoice line-item sync", {
            invoiceId,
            outcome: syncResult.outcome,
            mapped: mapResult.mapped,
          });
        } catch (e) {
          console.error("[square-webhook] invoice line-item sync failed", e);
        }
      }

      return;
    }

    // Refund events: refunds never change order state, so the order sync can't
    // see them. Persist the refund (nets against revenue on statements) and
    // re-sync the underlying order so its stored totals/raw stay fresh. Refunds
    // don't add consumption, so they skip the taproom reconcile below.
    if (isRefundEvent(event.type)) {
      const refund = extractSquareRefund(event);
      if (refund) {
        try {
          const result = await syncRefunds(supabase, [refund]);
          console.log("[square-webhook] refund sync", {
            type: event.type,
            refundId: refund.id,
            orderId: refund.order_id ?? null,
            synced: result.synced,
            errors: result.errors?.length ?? 0,
          });
        } catch (e) {
          console.error("[square-webhook] refund sync failed", e);
        }
        if (refund.order_id) {
          try {
            await syncPosOrdersByIds(supabase, [refund.order_id]);
          } catch (e) {
            console.error("[square-webhook] refund order re-sync failed", e);
          }
        }
      }
      return;
    }

    const orderId = extractSquareOrderId(event);

    // 1) Finance transactions — sync just the changed order (upsert on COMPLETED,
    // withdraw on CANCELED). Wrapped independently so a failure here doesn't skip
    // the taproom reconcile.
    if (orderId) {
      try {
        const result = await syncPosOrdersByIds(supabase, [orderId]);
        console.log("[square-webhook] finance sync", {
          type: event.type,
          orderId,
          synced: result.synced,
          canceled: result.canceled,
          errors: result.errors?.length ?? 0,
        });
      } catch (e) {
        // Logged, not returned — Square already has its 200; the daily sync/cron
        // and the manual "Sync from Square" button reconcile too.
        console.error("[square-webhook] finance sync failed", e);
      }
    }

    // 2) Taproom consumption reconcile over a short window.
    try {
      const result = await runTaproomConsumptionSync(supabase, { days: WINDOW_DAYS });
      console.log("[square-webhook] reconcile", {
        type: event.type,
        recordedUnits: result.recordedUnits,
        recountsApplied: result.recountsApplied,
        discrepancies: result.discrepancies.length,
      });
    } catch (e) {
      // Logged, not returned — Square already has its 200; the cron reconciles too.
      console.error("[square-webhook] reconcile failed", e);
    }
  });

  return NextResponse.json({ ok: true, queued: true, type: event.type });
}
