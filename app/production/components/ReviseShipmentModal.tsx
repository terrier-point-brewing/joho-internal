"use client";

import { useEffect, useState } from "react";
import { Modal, Field } from "@/app/components/ui/Modal";
import Banner from "@/app/components/ui/Banner";

/**
 * Revise what a shipment says actually went out.
 *
 * Distinct from Edit Shipment, which re-labels: same beer, same units, different
 * channel or recipient. This changes the units themselves, which means the
 * shipment is unshipped and rebooked — the stock comes back into cold storage and
 * the partner's allocation credit is re-planned against the new volume.
 *
 * The filed-period banner is NOT decided here. It comes from the GET, which calls
 * the same `filedPeriodExplanation` the revision itself uses to choose between
 * correcting in place and writing a reversal, so the sentence on screen and the
 * behaviour behind it cannot drift apart.
 */

interface ReviseLine {
  id: string;
  variantLabel: string | null;
  quantity: number;
}

interface Variation {
  variationId: string;
  name: string;
  format: string;
}

interface RevisePreview {
  revisable: boolean;
  shippedOn: string;
  channel: string;
  recipientName: string | null;
  filedPeriodNote: string | null;
  lines: ReviseLine[];
  variations: Variation[];
}

interface DraftLine {
  variationId: string;
  quantity: string;
}

interface ReviseShipmentModalProps {
  shipmentId: string;
  onClose: () => void;
  onSaved: () => void;
}

export default function ReviseShipmentModal({ shipmentId, onClose, onSaved }: ReviseShipmentModalProps) {
  const [preview, setPreview] = useState<RevisePreview | null>(null);
  const [draft, setDraft] = useState<DraftLine[]>([]);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/production/shipments/${shipmentId}/revise`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(json.error ?? "Could not load this shipment");
        setPreview(json as RevisePreview);
        // Seed the form with what actually shipped, matched to its variation so
        // an unchanged line rebooks identically.
        setDraft(
          (json.lines as ReviseLine[]).map((l) => ({
            variationId:
              (json.variations as Variation[]).find((v) => v.name === l.variantLabel)?.variationId ?? "",
            quantity: String(l.quantity),
          })),
        );
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load this shipment");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shipmentId]);

  function updateLine(i: number, patch: Partial<DraftLine>) {
    setDraft((d) => d.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  const lines = draft
    .map((l) => ({ variation_id: l.variationId, quantity: Number(l.quantity) }))
    .filter((l) => l.variation_id && l.quantity > 0);

  const original = preview?.lines ?? [];
  const unitsBefore = original.reduce((s, l) => s + l.quantity, 0);
  const unitsAfter = lines.reduce((s, l) => s + l.quantity, 0);
  const isUnship = lines.length === 0;
  const changed =
    isUnship ||
    lines.length !== original.length ||
    draft.some((l, i) => Number(l.quantity) !== original[i]?.quantity) ||
    new Set(draft.map((l) => l.variationId)).size !== draft.length ||
    draft.some((l, i) => l.variationId !== preview?.variations.find((v) => v.name === original[i]?.variantLabel)?.variationId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/production/shipments/${shipmentId}/revise`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines, reason: reason.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Revision failed");

      onSaved();
      const all: string[] = [
        ...(json.warnings ?? []),
        ...((json.reserveWarnings ?? []) as Array<{ message?: string }>).map(
          (w) => w.message ?? String(w),
        ),
      ].filter(Boolean);
      if (all.length > 0) setWarnings(all);
      else onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Revision failed");
    } finally {
      setSaving(false);
    }
  }

  if (warnings) {
    return (
      <Modal title="Shipment Revised" onClose={onClose}>
        <div className="space-y-3 text-xs">
          <p className="text-success">
            {isUnship
              ? `Shipment reversed. ${unitsBefore} units are back in cold storage.`
              : `Shipment revised to ${unitsAfter} units. ${Math.max(unitsBefore - unitsAfter, 0)} returned to cold storage.`}
          </p>
          <Banner>
            <ul className="list-disc pl-4 space-y-1">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </Banner>
          <div className="flex justify-end pt-2 border-t border-line">
            <button type="button" onClick={onClose} className="btn-primary">
              Got it
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  if (!preview) {
    return (
      <Modal title="Revise Shipment" onClose={onClose}>
        {error ? <Banner>{error}</Banner> : <p className="text-xs text-muted">Loading…</p>}
      </Modal>
    );
  }

  if (!preview.revisable) {
    return (
      <Modal title="Revise Shipment" onClose={onClose}>
        <Banner>
          This shipment can no longer be revised. If it has been invoiced, cancel the invoice on the
          Export Invoices tab first.
        </Banner>
      </Modal>
    );
  }

  return (
    <Modal title="Revise Shipment" onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-4">
        {preview.filedPeriodNote && <Banner tone="accent">{preview.filedPeriodNote}</Banner>}

        <p className="text-xs text-muted">
          Shipped {preview.shippedOn}
          {preview.recipientName ? ` to ${preview.recipientName}` : ""}. Changing these quantities
          returns the difference to cold storage and re-plans the allocation credit.
        </p>

        <div className="space-y-2">
          {draft.map((line, i) => (
            <div key={i} className="flex items-center gap-2">
              <label htmlFor={`rev-var-${i}`} className="sr-only">
                Packaging
              </label>
              <select
                id={`rev-var-${i}`}
                className="inp-sm flex-1"
                value={line.variationId}
                onChange={(e) => updateLine(i, { variationId: e.target.value })}
              >
                <option value="">Remove this line</option>
                {preview.variations.map((v) => (
                  <option key={v.variationId} value={v.variationId}>
                    {v.name}
                  </option>
                ))}
              </select>
              <label htmlFor={`rev-qty-${i}`} className="sr-only">
                Quantity
              </label>
              <input
                id={`rev-qty-${i}`}
                type="number"
                min="0"
                className="inp-sm w-24"
                value={line.quantity}
                onChange={(e) => updateLine(i, { quantity: e.target.value })}
              />
              <span className="text-xs text-muted w-24 shrink-0">
                was {original[i]?.quantity ?? 0}
              </span>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setDraft((d) => [...d, { variationId: "", quantity: "1" }])}
            className="btn-secondary"
          >
            + Add packaging
          </button>
        </div>

        {isUnship && (
          <Banner>
            Every line is removed, so this shipment will be reversed entirely and nothing will
            replace it. All {unitsBefore} units go back to cold storage.
          </Banner>
        )}

        <Field label="Reason" required hint="recorded on both the original and the replacement">
          <input
            className="inp"
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. miscounted at the bay — 8 went out, not 10"
          />
        </Field>

        {error && <Banner>{error}</Banner>}

        <div className="flex justify-end gap-2 pt-2 border-t border-line">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button type="submit" disabled={saving || !reason.trim() || !changed} className="btn-primary">
            {saving ? "Revising…" : isUnship ? "Reverse Shipment" : "Revise Shipment"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
