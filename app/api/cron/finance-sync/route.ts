/**
 * Daily cron: reconcile finance transactions (Square orders + refunds) into
 * square_orders / pos_line_items / square_refunds.
 *
 * Safety net for the Square webhook (app/api/webhooks/square) — if a delivery is
 * missed, this re-syncs a trailing window so the finance grid and financial
 * statements self-heal within a day. Idempotent (upsert per square_order_id /
 * square_refund_id), so overlap with the webhook is harmless. The run summary
 * lands in cron_runs.detail for the Settings → Cron Jobs monitor.
 */
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { runCronJob } from "@/lib/cron/runCronJob";
import { syncPosTransactionsForRange } from "@/lib/finance/syncPosTransactions";
import { syncRefundsForRange } from "@/lib/finance/syncRefunds";
import { reconcileInvoiceStatus } from "@/lib/finance/reconcileInvoiceStatus";
import { syncSquareInvoicesForYear } from "@/lib/finance/syncSquareInvoices";
import { autoMapInvoiceLineItems } from "@/lib/finance/autoMap";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

const WINDOW_DAYS = 3;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const outcome = await runCronJob("finance-sync", async () => {
    const supabase = createSupabaseAdminClient();
    const now = new Date();
    const endDate = now.toISOString().slice(0, 10);
    const startDate = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);

    const orders = await syncPosTransactionsForRange(supabase, startDate, endDate);
    const refunds = await syncRefundsForRange(supabase, startDate, endDate);

    // Safety-net for the invoice webhook: re-reconcile every non-terminal Square
    // invoice so a missed delivery self-heals within a day. Bounded to unpaid
    // invoices; idempotent (same code path as the webhook).
    const { data: openInvoices, error: openInvoicesErr } = await supabase
      .from("invoices")
      .select("square_invoice_id")
      .eq("source", "square")
      .not("square_invoice_id", "is", null)
      .in("status", ["draft", "open", "partial"]);
    if (openInvoicesErr) console.error("[finance-sync] failed to load non-terminal invoices", openInvoicesErr);

    let invoicesReconciled = 0;
    for (const row of openInvoices ?? []) {
      try {
        await reconcileInvoiceStatus(supabase, row.square_invoice_id as string);
        invoicesReconciled++;
      } catch (e) {
        console.error("[finance-sync] invoice reconcile failed", { squareInvoiceId: row.square_invoice_id, error: e });
      }
    }

    // Safety net for the invoice webhook's per-year line-item sync: re-syncs the
    // current year's invoices + fill-maps any unmapped lines in case a webhook
    // delivery was missed.
    const year = new Date().getFullYear();
    const invoiceLineSync = await syncSquareInvoicesForYear(supabase, year);
    const invoiceAutoMap = await autoMapInvoiceLineItems(supabase, { year });

    return {
      windowDays: WINDOW_DAYS,
      orders,
      refunds,
      invoicesReconciled,
      invoiceLineSync: { synced: invoiceLineSync.synced, updated: invoiceLineSync.updated },
      invoiceAutoMapped: invoiceAutoMap.mapped,
    };
  });

  return outcome.ok ? NextResponse.json(outcome.detail) : apiError(outcome.error);
}
