import type { SupabaseClient } from "@supabase/supabase-js";
import { getInvoiceStatus, getOrderPayment } from "@/lib/square/square-invoices";
import { isSquareNotFound } from "@/lib/square/client";
import { mapSquareInvoiceStatus } from "@/lib/finance/invoiceStatus";
import type { InvoiceStatus } from "@/types/finance";

/**
 * Synthetic Square status recorded when an invoice was deleted directly in the
 * Square dashboard (Square returns 404 / `NOT_FOUND`, so there is no real status
 * to read). Treated as terminal: it maps to a `voided` ledger row and reopens a
 * deposit allocation for regeneration, exactly like CANCELED/FAILED.
 */
export const MISSING_SQUARE_STATUS = "DELETED";

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

/**
 * Push a ledger status onto `export_transactions.status` for one invoice.
 * Shared by `reconcileInvoiceStatus` (webhook/cron/manual-sync path) and the
 * Square invoice sync (`syncSquareInvoicesForYear`/`syncSquareInvoiceById` via
 * `upsertInvoiceWithLines`) so BOTH invoice-status writers cascade to exports —
 * previously only the reconcile path did, so an invoice that flipped to paid
 * via a plain Square sync (no reconcile in between) left its shipments stuck
 * on Unpaid even though the invoice ledger correctly showed Paid.
 * draft/voided/unknown never touch export_transactions; paid/open/partial do.
 */
export async function cascadeExportTransactionsStatus(
  supabase: SupabaseClient,
  invoiceId: string,
  ledgerStatus: InvoiceStatus,
): Promise<number> {
  const exportTarget = exportStatusForLedger(ledgerStatus);
  if (exportTarget === "paid") {
    const { data, error } = await supabase
      .from("export_transactions")
      .update({ status: "paid" })
      .eq("invoice_id", invoiceId)
      .neq("status", "paid")
      .select("id");
    if (error) throw new Error(`export_transactions paid update failed: ${error.message}`);
    return data?.length ?? 0;
  }
  if (exportTarget === "unpaid") {
    const { data, error } = await supabase
      .from("export_transactions")
      .update({ status: "unpaid" })
      .eq("invoice_id", invoiceId)
      .eq("status", "invoice_required")
      .select("id");
    if (error) throw new Error(`export_transactions unpaid update failed: ${error.message}`);
    return data?.length ?? 0;
  }
  return 0;
}

export interface AllocationInvoiceState {
  invoice_sent_at: string | null;
  invoice_paid_at: string | null;
}

export interface AllocationInvoiceTimestamps {
  invoice_sent_at?: string | null;
  invoice_paid_at?: string | null;
}

const SQUARE_TERMINAL_FAILURE = new Set(["CANCELED", "FAILED", MISSING_SQUARE_STATUS]);

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
  /**
   * True when Square returned 404 / NOT_FOUND — the invoice was deleted directly
   * in the Square dashboard. The reconcile treats this as terminal (voids the
   * ledger row) rather than throwing, so the daily cron stops re-hitting it.
   */
  invoiceMissing?: boolean;
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
  let sq: Awaited<ReturnType<typeof getInvoiceStatus>>;
  try {
    sq = await getInvoiceStatus(squareInvoiceId);
  } catch (err) {
    // Invoice deleted directly in Square (404 / NOT_FOUND). Terminal, not an
    // error to retry: void the ledger row so the daily cron's non-terminal
    // filter stops re-hitting it every run. Any other Square failure still
    // throws (transient — the cron/webhook should retry).
    if (isSquareNotFound(err)) return voidMissingInvoice(supabase, squareInvoiceId);
    throw err;
  }
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
  // A voided/refunded or draft ledger status yields no export target: we
  // intentionally leave already-`paid` export_transactions rows as paid on a
  // full refund (refunded dollars are tracked separately by the refund sync)
  // and never regress a paid row. Only paid/open/partial produce a target.
  base.updatedExportTransactions = await cascadeExportTransactionsStatus(supabase, inv.id, ledgerStatus);

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

/**
 * Handle a Square invoice that no longer exists (deleted in the Square
 * dashboard → 404 / NOT_FOUND from `getInvoiceStatus`). Terminal, never throws
 * for the missing invoice itself:
 *  - Void the finance ledger row (status → `voided`) and stamp raw_data so the
 *    daily cron's `('draft','open','partial')` filter no longer selects it —
 *    which stops the perpetual per-run error log.
 *  - Reopen any deposit allocation (clear `invoice_sent_at`) for regeneration,
 *    matching the CANCELED/FAILED path via `buildAllocationInvoiceTimestamps`.
 *
 * DB write failures still throw (a genuinely broken write should surface).
 */
async function voidMissingInvoice(
  supabase: SupabaseClient,
  squareInvoiceId: string,
): Promise<ReconcileInvoiceStatusResult> {
  const now = new Date().toISOString();
  const base: ReconcileInvoiceStatusResult = {
    squareInvoiceId,
    squareStatus: MISSING_SQUARE_STATUS,
    ledgerStatus: "voided",
    updatedLedger: false,
    updatedExportTransactions: 0,
    updatedAllocation: false,
    paymentCaptured: false,
    invoiceMissing: true,
  };

  const { data: inv } = await supabase
    .from("invoices")
    .select("id, raw_data")
    .eq("source", "square")
    .eq("square_invoice_id", squareInvoiceId)
    .maybeSingle();

  if (!inv) {
    console.warn("[reconcileInvoiceStatus] deleted Square invoice has no ledger row", { squareInvoiceId });
    return { ...base, skippedReason: "no-ledger-row" };
  }

  const rawData = { ...((inv.raw_data as Record<string, unknown> | null) ?? {}), square_status: MISSING_SQUARE_STATUS, deleted_at: now };
  const { error: ledgerErr } = await supabase
    .from("invoices")
    .update({ status: "voided", raw_data: rawData })
    .eq("id", inv.id);
  if (ledgerErr) throw new Error(`ledger void failed: ${ledgerErr.message}`);
  base.updatedLedger = true;

  // ── Deposit allocation ───────────────────────────────────────────────────────
  // A deleted deposit invoice reopens the allocation (same as CANCELED); no
  // payment could exist for a now-nonexistent invoice, so nothing to capture.
  const { data: alloc } = await supabase
    .from("batch_allocations")
    .select("id, invoice_sent_at, invoice_paid_at")
    .eq("square_deposit_invoice_id", squareInvoiceId)
    .maybeSingle();

  if (alloc) {
    const patch = buildAllocationInvoiceTimestamps({
      squareStatus: MISSING_SQUARE_STATUS,
      ledgerStatus: "voided",
      current: { invoice_sent_at: alloc.invoice_sent_at, invoice_paid_at: alloc.invoice_paid_at },
      paidAt: null,
      updatedAt: null,
      now,
    });
    if (Object.keys(patch).length > 0) {
      const { error: allocErr } = await supabase.from("batch_allocations").update(patch).eq("id", alloc.id);
      if (allocErr) throw new Error(`allocation void failed: ${allocErr.message}`);
      base.updatedAllocation = true;
    }
  }

  return base;
}
