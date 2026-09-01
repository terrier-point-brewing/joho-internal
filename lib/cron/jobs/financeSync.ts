/**
 * Reconciles finance transactions (Square orders + refunds) into square_orders /
 * pos_line_items / square_refunds.
 *
 * Safety net for the Square webhook (app/api/webhooks/square) — if a delivery is
 * missed, this re-syncs a trailing window so the finance grid and financial
 * statements self-heal within a day. Idempotent (upsert per square_order_id /
 * square_refund_id), so overlap with the webhook is harmless. The run summary
 * lands in cron_runs.detail for the Settings → Cron Jobs monitor.
 *
 * ── Which connection this reports against ────────────────────────────────────
 * The Square one. §6 of docs/finance/balance-methods-handoff.md lists this cron
 * alongside ramp-expenses-sync under "report sync health through the connection
 * store", but this job touches no Ramp data at all — it syncs Square orders,
 * refunds and invoices, and what goes stale when it fails is the Square-derived
 * balance on GL 1040. Recording it against the Ramp row would put a true
 * failure on the wrong integration, which is worse than not recording it.
 *
 * Reported from HERE rather than from the route, so a "Run now" tells the
 * connection the same thing the schedule does.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncPosTransactionsForRange } from "@/lib/finance/syncPosTransactions";
import { syncRefundsForRange } from "@/lib/finance/syncRefunds";
import { reconcileInvoiceStatus } from "@/lib/finance/reconcileInvoiceStatus";
import { syncSquareInvoicesForYear } from "@/lib/finance/syncSquareInvoices";
import { autoMapInvoiceLineItems } from "@/lib/finance/autoMap";
import { syncSquareFeesForRange } from "@/lib/finance/syncSquareFees";
import { recordProviderSyncResult } from "@/lib/finance/balances/connections";

/**
 * How far back each run re-syncs. Widened from 3 once re-syncs stopped
 * clobbering hand-set GL mappings (PR #315) — before that, a wider window meant
 * a wider nightly *destructive* rebuild, so 3 days was a cap on the blast
 * radius rather than a judgement about coverage.
 *
 * Still deliberately short, but no longer because a wider window would do
 * damage. Invoice-backed orders in the window used to have their
 * invoice_line_items rebuilt through a second, non-canonical writer that
 * numbered rows differently from the canonical one; that writer is gone and
 * this path now preserves hand-set accounts on both kinds of line. What bounds
 * the window now is plain cost: a week covers a long weekend of failed webhook
 * deliveries, and anything older is the gap scan's job
 * (lib/cron/jobs/financeGapScan.ts), which re-syncs only the days that actually
 * disagree with Square.
 *
 * The window is fixed rather than chosen by the caller for a reason: a manual
 * run has to mean the same thing as a scheduled one, or the monitor's history
 * stops being comparable. Re-pulling an arbitrary range is a separate feature.
 */
const WINDOW_DAYS = 7;

export async function runFinanceSync(supabase: SupabaseClient) {
  try {
    return await syncEverything(supabase);
  } catch (err) {
    // Recorded and then rethrown: the Square connection needs to say what went
    // wrong, and the run still needs to be marked failed.
    const message = err instanceof Error ? err.message : String(err);
    await recordProviderSyncResult(supabase, "square", { ok: false, error: `Square sync failed: ${message}` });
    throw err;
  }
}

/**
 * The run itself, lifted out so the failure path has one place to catch rather
 * than eighty lines wrapped in a try block.
 */
async function syncEverything(supabase: SupabaseClient) {
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

  // Processing fees for the same window (the whole history on an empty table
  // -- see syncSquareFees.ts). Swallowed, not thrown: fees are a derived P&L
  // convenience over payments that are already safely recorded, and failing
  // the orders sync over them would cost real data to protect a nicety.
  let fees: { upserted: number; from: string } | { error: string };
  try {
    fees = await syncSquareFeesForRange(supabase, startDate, endDate);
  } catch (e) {
    console.error("[finance-sync] square fee sync failed", e);
    fees = { error: e instanceof Error ? e.message : String(e) };
  }

  return {
    windowDays: WINDOW_DAYS,
    orders,
    refunds,
    invoicesReconciled,
    invoiceLineSync: { synced: invoiceLineSync.synced, updated: invoiceLineSync.updated },
    invoiceAutoMapped: invoiceAutoMap.mapped,
    fees,
  };
}
