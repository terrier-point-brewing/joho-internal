import type { SupabaseClient } from "@supabase/supabase-js";
import { getInvoiceStatus, getOrderPayment } from "@/lib/square/square-invoices";
import { mapSquareInvoiceStatus } from "@/lib/finance/invoiceStatus";
import type { InvoiceStatus } from "@/types/finance";

/**
 * Target `export_transactions.status` for a given ledger status, or null when
 * the status should not touch export transactions. `paid` settles the invoice's
 * lines; `open`/`partial` mean it's out (unpaid). draft/voided/unknown are
 * left alone (the orchestrator never regresses a paid row).
 */
export function exportStatusForLedger(ledger: InvoiceStatus): "paid" | "unpaid" | null {
  if (ledger === "paid") return "paid";
  if (ledger === "open" || ledger === "partial") return "unpaid";
  return null;
}

export interface AllocationInvoiceState {
  invoice_sent_at: string | null;
  invoice_paid_at: string | null;
}

export interface AllocationInvoiceTimestamps {
  invoice_sent_at?: string | null;
  invoice_paid_at?: string | null;
}

const SQUARE_TERMINAL_FAILURE = new Set(["CANCELED", "FAILED"]);

/**
 * Compute the deposit-allocation timestamp changes for a reconcile. Pure — the
 * orchestrator applies the returned patch and separately captures the payment
 * reference. Rules:
 *  - CANCELED/FAILED  → clear invoice_sent_at (reopen for regeneration)
 *  - past DRAFT & not yet sent → set invoice_sent_at (published = sent)
 *  - paid & not yet paid       → set invoice_paid_at
 * An empty object means nothing changed (idempotent re-delivery).
 */
export function buildAllocationInvoiceTimestamps(params: {
  squareStatus: string;
  ledgerStatus: InvoiceStatus;
  current: AllocationInvoiceState;
  paidAt: string | null;
  updatedAt: string | null;
  now: string;
}): AllocationInvoiceTimestamps {
  const { squareStatus, ledgerStatus, current, paidAt, updatedAt, now } = params;
  const patch: AllocationInvoiceTimestamps = {};
  const sq = squareStatus.toUpperCase();

  if (SQUARE_TERMINAL_FAILURE.has(sq)) {
    if (current.invoice_sent_at !== null) patch.invoice_sent_at = null;
    return patch;
  }

  // Any state past DRAFT means the invoice was published (sent).
  if (sq !== "DRAFT" && !current.invoice_sent_at) {
    patch.invoice_sent_at = updatedAt ?? now;
  }

  if (ledgerStatus === "paid" && !current.invoice_paid_at) {
    patch.invoice_paid_at = paidAt ?? now;
  }

  return patch;
}

export interface ReconcileInvoiceStatusResult {
  squareInvoiceId: string;
  squareStatus: string;
  ledgerStatus: InvoiceStatus;
  updatedLedger: boolean;
  updatedExportTransactions: number;
  updatedAllocation: boolean;
  paymentCaptured: boolean;
  skippedReason?: "no-ledger-row";
}

/**
 * Reconcile one Square invoice's status into every consumer that tracks it:
 * the finance ledger (`invoices`), export transactions (`export_transactions`
 * via invoice_id), and deposit allocations (`batch_allocations` via
 * `square_deposit_invoice_id`). Refetches from Square (source of truth) rather
 * than trusting a webhook payload. Idempotent — safe to call repeatedly and
 * from the webhook, the manual sync actions, and the daily cron.
 *
 * `supabase` must be an admin client (cross-table writes, server-side).
 */
export async function reconcileInvoiceStatus(
  supabase: SupabaseClient,
  squareInvoiceId: string,
): Promise<ReconcileInvoiceStatusResult> {
  const sq = await getInvoiceStatus(squareInvoiceId);
  const ledgerStatus = mapSquareInvoiceStatus(sq.status);
  const now = new Date().toISOString();

  const base: ReconcileInvoiceStatusResult = {
    squareInvoiceId,
    squareStatus: sq.status,
    ledgerStatus,
    updatedLedger: false,
    updatedExportTransactions: 0,
    updatedAllocation: false,
    paymentCaptured: false,
  };

  // ── Finance ledger ─────────────────────────────────────────────────────────
  const { data: inv } = await supabase
    .from("invoices")
    .select("id, raw_data")
    .eq("source", "square")
    .eq("square_invoice_id", squareInvoiceId)
    .maybeSingle();

  if (!inv) {
    console.warn("[reconcileInvoiceStatus] no ledger row for invoice", { squareInvoiceId, squareStatus: sq.status });
    return { ...base, skippedReason: "no-ledger-row" };
  }

  const rawData = { ...(inv.raw_data as Record<string, unknown> | null ?? {}), square_status: sq.status, updated_at: sq.updatedAt, paid_at: sq.paidAt };
  const { error: ledgerErr } = await supabase
    .from("invoices")
    .update({
      status: ledgerStatus,
      ...(sq.invoiceNumber ? { invoice_number: sq.invoiceNumber } : {}),
      raw_data: rawData,
    })
    .eq("id", inv.id);
  if (ledgerErr) throw new Error(`ledger update failed: ${ledgerErr.message}`);
  base.updatedLedger = true;

  // ── Export transactions (invoice_id FK) ──────────────────────────────────────
  const exportTarget = exportStatusForLedger(ledgerStatus);
  if (exportTarget === "paid") {
    const { data, error: exPaidErr } = await supabase
      .from("export_transactions")
      .update({ status: "paid" })
      .eq("invoice_id", inv.id)
      .neq("status", "paid")
      .select("id");
    if (exPaidErr) throw new Error(`export_transactions paid update failed: ${exPaidErr.message}`);
    base.updatedExportTransactions = data?.length ?? 0;
  } else if (exportTarget === "unpaid") {
    // Advance invoice_required → unpaid on publish; never regress a paid row.
    const { data, error: exUnpaidErr } = await supabase
      .from("export_transactions")
      .update({ status: "unpaid" })
      .eq("invoice_id", inv.id)
      .eq("status", "invoice_required")
      .select("id");
    if (exUnpaidErr) throw new Error(`export_transactions unpaid update failed: ${exUnpaidErr.message}`);
    base.updatedExportTransactions = data?.length ?? 0;
  }

  // ── Deposit allocation (square_deposit_invoice_id) ───────────────────────────
  const { data: alloc } = await supabase
    .from("batch_allocations")
    .select("id, invoice_sent_at, invoice_paid_at, square_payment_id, square_deposit_order_id")
    .eq("square_deposit_invoice_id", squareInvoiceId)
    .maybeSingle();

  if (alloc) {
    const patch: Record<string, unknown> = { ...buildAllocationInvoiceTimestamps({
      squareStatus: sq.status,
      ledgerStatus,
      current: { invoice_sent_at: alloc.invoice_sent_at, invoice_paid_at: alloc.invoice_paid_at },
      paidAt: sq.paidAt,
      updatedAt: sq.updatedAt,
      now,
    }) };

    // Capture the payment reference the first time we record payment — the only
    // point Square exposes it; required for later refunds.
    const newlyPaid = patch.invoice_paid_at != null;
    if (newlyPaid && !alloc.square_payment_id && alloc.square_deposit_order_id) {
      const { paymentId, amountPaidCents } = await getOrderPayment(alloc.square_deposit_order_id);
      if (paymentId) {
        patch.square_payment_id = paymentId;
        patch.deposit_amount_paid_cents = amountPaidCents;
        base.paymentCaptured = true;
      } else {
        console.error(`[reconcileInvoiceStatus] allocation ${alloc.id}: invoice PAID but no Square payment_id on order ${alloc.square_deposit_order_id} — refunds unavailable until manually resolved.`);
      }
    }

    if (Object.keys(patch).length > 0) {
      const { error: allocErr } = await supabase.from("batch_allocations").update(patch).eq("id", alloc.id);
      if (allocErr) throw new Error(`allocation update failed: ${allocErr.message}`);
      base.updatedAllocation = true;
    }
  }

  return base;
}
