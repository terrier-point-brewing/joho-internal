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
