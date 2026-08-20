"use client";

import { useState } from "react";
import { Modal, Field } from "./shared";

/**
 * Cancel an export invoice that should not have gone out.
 *
 * Deliberately plain: there is nothing to plan and no math to preview, unlike
 * Credit Invoice. The only input is a reason, and the only thing worth putting on
 * screen is what the operator is about to get back — the shipments, returned to
 * the Invoice Required queue, where they can be re-invoiced or revised.
 *
 * Warnings from the server are shown INSTEAD of a success toast and the modal
 * stays open when there are any. They mean the cancel happened but something
 * downstream did not — most importantly a Square count that did not rise, which
 * is the operator's only signal that re-invoicing would deduct the same units
 * twice. Closing over that would bury the one thing they need to read.
 */

interface CancelInvoiceModalProps {
  invoiceId: string;
  invoiceNumber: string | null;
  status: string;
  shipmentCount: number;
  onClose: () => void;
  onDone: () => void;
}

interface CancelResult {
  releasedShipments: number;
  reversedSubstitutions: number;
  warnings: string[];
}

export default function CancelInvoiceModal({
  invoiceId,
  invoiceNumber,
  status,
  shipmentCount,
  onClose,
  onDone,
}: CancelInvoiceModalProps) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CancelResult | null>(null);

  const wasSent = status !== "draft";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/production/export/invoices/${invoiceId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Cancel failed");

      onDone();
      // Anything the operator still has to act on keeps the modal up; a clean
      // cancel just closes.
      if (Array.isArray(body.warnings) && body.warnings.length > 0) {
        setResult(body as CancelResult);
      } else {
        onClose();
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Cancel failed");
    } finally {
      setSubmitting(false);
    }
  }

  const title = `Cancel Invoice ${invoiceNumber ?? ""}`.trim();

  if (result) {
    return (
      <Modal title={title} onClose={onClose}>
        <div className="space-y-3 text-xs">
          <p className="text-success">
            Invoice cancelled.{" "}
            {result.releasedShipments === 1
              ? "1 shipment is back in the Invoice Required queue."
              : `${result.releasedShipments} shipments are back in the Invoice Required queue.`}
          </p>
          <div className="rounded border border-danger-border bg-danger-surface/30 p-3 space-y-2">
            <p className="font-medium text-danger">Still needs a look</p>
            <ul className="list-disc pl-4 space-y-1 text-body">
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
          <div className="flex justify-end pt-2 border-t border-line">
            <button type="button" onClick={onClose} className="btn-primary">
              Got it
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded border border-line bg-surface/40 p-3 space-y-2 text-xs text-body">
          <p>
            {wasSent
              ? "This invoice will be cancelled in Square. The customer's copy stops being payable."
              : "This draft will be deleted in Square."}
          </p>
          <p>
            {shipmentCount === 1
              ? "Its 1 shipment goes back to Invoice Required"
              : `Its ${shipmentCount} shipments go back to Invoice Required`}
            , ready to be re-invoiced — or revised first, on the Shipments tab.
          </p>
          <p className="text-muted">
            The beer stays shipped. Cold storage, allocations and excise are not touched — cancelling
            the bill is not the same as un-shipping.
          </p>
        </div>

        <Field label="Reason" required hint="recorded on the invoice">
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. wrong quantity — reshipping 8 not 10"
            className="inp w-full"
            autoFocus
          />
        </Field>

        {error && <p className="text-xs text-danger">{error}</p>}

        <div className="flex justify-end gap-2 pt-2 border-t border-line">
          <button type="button" onClick={onClose} className="btn-secondary">
            Keep Invoice
          </button>
          <button type="submit" disabled={submitting || !reason.trim()} className="btn-danger">
            {submitting ? "Cancelling…" : "Cancel Invoice"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
