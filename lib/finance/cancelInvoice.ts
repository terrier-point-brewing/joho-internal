// lib/finance/cancelInvoice.ts
//
// Killing an export invoice that should not have gone out.
//
// A cancel is not a refund. A refund settles money that changed hands and leaves
// the shipment shipped; a cancel says this invoice should never have existed, and
// its shipments go back to the Invoice Required queue to be billed again — or
// revised first, which is the only way to revise them at all (a shipment
// attached to a live invoice is not editable, by design: the invoice already
// went to the customer).
//
// Four things unwind, in this order, and the order is the whole design:
//
//   1. Square         cancel or delete the invoice object. FIRST, because it is
//                     the only step that can fail in a way we cannot undo. If
//                     Square refuses, nothing local has moved and the operator
//                     can simply try again.
//   2. Square stock   take back any substitution credit (see below).
//   3. Ledger         invoices.status -> voided, with the operator's reason.
//   4. Shipments      export_transactions back to invoice_required, invoice_id
//                     cleared, via the shared cascade so a cancel done in the
//                     Square dashboard lands identically.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//
// It does not touch cold storage, allocations, commitments or excise. The beer
// still shipped. Cancelling the bill for a shipment does not un-ship it, and an
// invoice cancel that quietly restocked would be a silent inventory write nobody
// asked for. Reversing the shipment itself is a separate, explicit action.
//
// THE SQUARE INVENTORY PROBLEM
//
// Publishing an invoice is what makes Square decrement a tracked SKU. Cancelling
// it is what makes Square put those units back — Square's own behaviour, not
// ours, and we do not get to assume it happened. Two consequences:
//
//   * A substitution credit (lib/production/invoiceSkuSubstitutions) exists only
//     to offset a deduction against a BORROWED item. Once Square restocks that
//     borrowed item on cancel, the credit is an unmatched addition and Square is
//     over by exactly the credited quantity. So it is taken back out here.
//
//   * Releasing a row from `unpaid` to `invoice_required` re-arms
//     selectPendingDeductionRecipes: it starts believing Square still owes a
//     deduction for that shipment. That is only true if Square really did
//     restock. So the cancel VERIFIES it, by reading the affected SKUs' counts
//     before and after, and reports what it saw rather than asserting. A
//     verification that fails does not fail the cancel — the invoice is already
//     dead in Square and saying otherwise would be false — it becomes a warning
//     naming the SKU and the numbers.

import type { SupabaseClient } from "@supabase/supabase-js";
import { cancelInvoice as cancelSquareInvoice, getInvoiceStatus } from "@/lib/square/square-invoices";
import { isSquareNotFound } from "@/lib/square/client";
import { fetchCurrentCounts } from "@/lib/square/inventory";
import { reverseSubstitutedInventory } from "@/lib/production/invoiceSkuSubstitutions";
import { cascadeExportTransactionsStatus } from "@/lib/finance/reconcileInvoiceStatus";

/**
 * Ledger statuses a cancel may act on.
 *
 * `paid` is absent on purpose and is not an oversight: money has changed hands,
 * and the instrument for giving it back is a refund (Credit Invoice), which
 * writes a return, reverses the excise pro-rata and restocks. Cancelling a paid
 * invoice would erase the revenue while leaving the payment sitting in Square.
 */
const CANCELLABLE: readonly string[] = ["draft", "open", "partial"];

export class CancelInvoiceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "CancelInvoiceError";
  }
}

export interface CancelInvoiceResult {
  invoiceId: string;
  /** Square's status immediately before the cancel, or null when it was already gone. */
  squareStatusBefore: string | null;
  /** Shipments returned to the Invoice Required queue. */
  releasedShipments: number;
  /** Substitution credits taken back out of Square. */
  reversedSubstitutions: number;
  /** Non-fatal follow-ups. The cancel succeeded; a human may still need to act. */
  warnings: string[];
}

interface CancelParams {
  invoiceId: string;
  reason: string;
  userId?: string | null;
}

/**
 * The SKUs Square should have restocked when it cancelled this invoice: the
 * inventory-tracked catalog variations on its own line items. Read before the
 * cancel so the counts can be compared after it.
 */
async function trackedVariationsOnInvoice(
  supabase: SupabaseClient,
  invoiceId: string,
): Promise<string[]> {
  const { data: lines } = await supabase
    .from("invoice_line_items")
    .select("square_catalog_variation_id")
    .eq("invoice_id", invoiceId)
    .not("square_catalog_variation_id", "is", null);

  const ids = [...new Set((lines ?? []).map((l) => l.square_catalog_variation_id as string))];
  if (ids.length === 0) return [];

  const { data: variations } = await supabase
    .from("square_catalog_variations")
    .select("square_variation_id, track_inventory")
    .in("square_variation_id", ids)
    .eq("is_deleted", false);

  return (variations ?? [])
    .filter((v) => v.track_inventory)
    .map((v) => v.square_variation_id as string);
}

/**
 * Cancel one export invoice.
 *
 * `supabase` must be an admin client: this writes across invoices,
 * export_transactions and invoice_sku_substitutions, and the finance tables are
 * reader-only to the session role.
 */
export async function cancelExportInvoice(
  supabase: SupabaseClient,
  { invoiceId, reason, userId = null }: CancelParams,
): Promise<CancelInvoiceResult> {
  const trimmedReason = reason?.trim();
  if (!trimmedReason) {
    throw new CancelInvoiceError("A reason is required to cancel an invoice.", 400);
  }

  const { data: inv, error: invErr } = await supabase
    .from("invoices")
    .select("id, status, square_invoice_id, invoice_number, invoice_type")
    .eq("id", invoiceId)
    .single();
  if (invErr || !inv) throw new CancelInvoiceError("Invoice not found.", 404);

  if (inv.status === "voided") {
    throw new CancelInvoiceError("This invoice has already been cancelled.", 409);
  }
  if (inv.status === "paid") {
    throw new CancelInvoiceError(
      "This invoice is paid — use Credit Invoice to give the money back. Cancelling would erase the revenue and leave the payment in Square.",
      422,
    );
  }
  if (!CANCELLABLE.includes(inv.status)) {
    throw new CancelInvoiceError(`An invoice with status "${inv.status}" cannot be cancelled.`, 422);
  }

  const warnings: string[] = [];
  const now = new Date().toISOString();

  // ── 1. Square ──────────────────────────────────────────────────────────────
  // Everything below this point is local and recoverable; this is the step that
  // is not, so it goes first and a failure leaves the invoice untouched.
  let squareStatusBefore: string | null = null;
  const squareInvoiceId = inv.square_invoice_id as string | null;

  // Which SKUs Square owes a restock on, read BEFORE the cancel so the counts
  // mean something afterwards.
  const trackedVariations = squareInvoiceId ? await trackedVariationsOnInvoice(supabase, invoiceId) : [];
  const countsBefore = trackedVariations.length
    ? await fetchCurrentCounts(trackedVariations).catch(() => new Map<string, number>())
    : new Map<string, number>();

  if (squareInvoiceId) {
    try {
      squareStatusBefore = (await getInvoiceStatus(squareInvoiceId)).status;
      await cancelSquareInvoice(squareInvoiceId);
    } catch (err) {
      // Already gone from Square. The local row is the thing that is out of
      // date, and voiding it is exactly the repair — not an error.
      if (isSquareNotFound(err)) {
        warnings.push("This invoice no longer existed in Square; the local record has been voided to match.");
      } else {
        const message = err instanceof Error ? err.message : String(err);
        throw new CancelInvoiceError(`Square would not cancel this invoice: ${message}`, 502);
      }
    }
  } else {
    // A `record`-source invoice (QuickBooks / other) has no Square object. There
    // is nothing to cancel there and nothing that deducted, so the local void is
    // the whole operation — but the operator still has to kill the real invoice
    // wherever it actually lives.
    warnings.push(
      "This invoice was recorded from outside Square, so nothing was cancelled there. Cancel it in the system that issued it.",
    );
  }

  // ── 2. Square stock ────────────────────────────────────────────────────────
  let reversedSubstitutions = 0;
  if (squareInvoiceId) {
    try {
      const reversal = await reverseSubstitutedInventory(supabase, invoiceId, now);
      reversedSubstitutions = reversal.reversed;
      warnings.push(...reversal.warnings);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`Substitution credits could not be read back: ${message}. Check Square's counts by hand.`);
    }

    // Did Square actually put the units back? Never asserted — only reported.
    // A shipment released to invoice_required tells the rest of the app that
    // Square still owes a deduction, and that is a lie if Square did not restock.
    if (trackedVariations.length > 0 && countsBefore.size > 0) {
      try {
        const countsAfter = await fetchCurrentCounts(trackedVariations);
        const unmoved = trackedVariations.filter((v) => {
          const before = countsBefore.get(v);
          const after = countsAfter.get(v);
          return before != null && after != null && after <= before;
        });
        if (unmoved.length > 0) {
          warnings.push(
            `Square's count did not rise for ${unmoved.length} of this invoice's ${trackedVariations.length} tracked items, so it may not have restocked them. Re-invoicing these shipments would deduct the same units a second time — check Square before sending the replacement.`,
          );
        }
      } catch {
        warnings.push("Square's counts could not be re-read, so the restock is unverified. Check them before re-invoicing.");
      }
    }
  }

  // ── 3. Ledger ──────────────────────────────────────────────────────────────
  const { error: voidErr } = await supabase
    .from("invoices")
    .update({
      status: "voided",
      voided_at: now,
      voided_reason: trimmedReason,
      notes: userId ? `Cancelled by ${userId}: ${trimmedReason}` : `Cancelled: ${trimmedReason}`,
    })
    .eq("id", invoiceId);
  if (voidErr) {
    throw new CancelInvoiceError(
      `The invoice was cancelled in Square but the local record could not be updated: ${voidErr.message}. Run Sync from Square to finish.`,
      500,
    );
  }

  // ── 4. Shipments ───────────────────────────────────────────────────────────
  // The shared cascade, not a bespoke update: a cancel done in the Square
  // dashboard reaches the same code through reconcileInvoiceStatus, and the two
  // must not be able to disagree about what a voided invoice does to a shipment.
  let releasedShipments = 0;
  try {
    releasedShipments = await cascadeExportTransactionsStatus(supabase, invoiceId, "voided");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(
      `The invoice is cancelled but its shipments could not be returned to the Invoice Required queue: ${message}. Run Sync from Square to retry.`,
    );
  }

  return {
    invoiceId,
    squareStatusBefore,
    releasedShipments,
    reversedSubstitutions,
    warnings,
  };
}
