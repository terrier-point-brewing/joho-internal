"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "./shared";
import { fmtUsd } from "@/lib/utils/formatting";

/**
 * Credit a paid invoice — the app-side replacement for refunding in the Square
 * dashboard, and the screen that explains a refund someone issued there anyway.
 *
 * The modal never decides refund math for itself. Every total on screen comes
 * from a `preview: true` round trip through the same planner the server enforces
 * with, so the number shown and the number charged cannot diverge. Quantity
 * inputs appear only on `per_unit` lines; derived lines (excise, packaging
 * materials, the invoice discount) are read-only and recalculate from what else
 * is credited, because they were never priced per unit in the first place.
 */

export type RefundReason = "price_correction" | "goods_returned" | "never_delivered";

const REASONS: { value: RefundReason; label: string; blurb: string }[] = [
  {
    value: "price_correction",
    label: "Price correction",
    blurb: "They were overcharged. The beer stays delivered — no stock moves and no excise is reversed.",
  },
  {
    value: "goods_returned",
    label: "Goods returned",
    blurb: "The beer came back. It returns to cold storage and the excise reverses.",
  },
  {
    value: "never_delivered",
    label: "Never delivered",
    blurb: "The beer never left. The excise reverses; nothing is added back to cold storage.",
  },
];

interface RefundableLine {
  id: string;
  label: string;
  category: string | null;
  basis: "per_unit" | "derived" | "flat";
  quantity: number;
  totalCents: number;
  hasVolume: boolean;
}

interface PlannedLine {
  lineId: string;
  basis: string;
  quantity: number | null;
  amountCents: number;
}

interface Plan {
  lines: PlannedLine[];
  totalCents: number;
  recreditsInventory: boolean;
  reversesExcise: boolean;
}

interface Props {
  invoiceId: string;
  invoiceNumber: string | null;
  /** Set when explaining a refund Square already made; locks the total. */
  classifyRefundId?: string | null;
  expectedCents?: number | null;
  onClose: () => void;
  onDone: () => void;
}

export function CreditInvoiceModal({
  invoiceId,
  invoiceNumber,
  classifyRefundId = null,
  expectedCents = null,
  onClose,
  onDone,
}: Props) {
  const [lines, setLines] = useState<RefundableLine[]>([]);
  const [qtyById, setQtyById] = useState<Record<string, string>>({});
  const [flatOn, setFlatOn] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState<RefundReason>("price_correction");
  const [note, setNote] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/production/export/invoices/${invoiceId}/refund`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(json.error ?? "Could not load the invoice's lines.");
        setLines(json.lines ?? []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [invoiceId]);

  const selections = useMemo(() => {
    const out: { lineId: string; quantity?: number }[] = [];
    for (const l of lines) {
      if (l.basis === "per_unit") {
        const q = Number(qtyById[l.id] ?? "");
        if (Number.isFinite(q) && q > 0) out.push({ lineId: l.id, quantity: q });
      } else if (l.basis === "flat" && flatOn[l.id]) {
        out.push({ lineId: l.id });
      }
    }
    return out;
  }, [lines, qtyById, flatOn]);

  // Re-plan on every change. The server is the only thing that knows what a
  // selection is worth — deriving it here would be a second implementation of
  // the arithmetic, and the two would eventually disagree.
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      // Cleared inside the timeout, not in the effect body: clearing
      // synchronously here would be a setState-in-effect cascade.
      if (selections.length === 0) { setPlan(null); setPlanError(null); return; }
      try {
        const res = await fetch(`/api/production/export/invoices/${invoiceId}/refund`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ preview: true, reason, selections }),
        });
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) { setPlan(null); setPlanError(json.error ?? "Could not price this credit."); return; }
        setPlan(json.plan); setPlanError(null);
      } catch (e) {
        if (!cancelled) { setPlan(null); setPlanError(e instanceof Error ? e.message : String(e)); }
      }
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [invoiceId, reason, selections]);

  const plannedById = useMemo(
    () => new Map((plan?.lines ?? []).map((l) => [l.lineId, l])),
    [plan],
  );

  // When explaining a refund Square already made, the selection has to add up to
  // what Square actually took. The server enforces this too; showing it here
  // stops the operator submitting a selection that cannot be right.
  const mismatch =
    classifyRefundId && plan && expectedCents != null && plan.totalCents !== expectedCents;

  async function submit() {
    setSubmitting(true); setError(null);
    try {
      const url = classifyRefundId
        ? `/api/production/export/refunds/${classifyRefundId}/classify`
        : `/api/production/export/invoices/${invoiceId}/refund`;
      const body = classifyRefundId
        ? { invoice_id: invoiceId, reason, selections, note: note || null }
        : { reason, selections, note: note || null };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Refund failed.");
      if (Array.isArray(json.warnings) && json.warnings.length > 0) {
        // Warnings mean the money moved but a consequence did not — the operator
        // must see them, so they interrupt rather than closing silently.
        setError(json.warnings.join(" "));
        setSubmitting(false);
        onDone();
        return;
      }
      onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  const title = classifyRefundId
    ? `Explain refund — Invoice ${invoiceNumber ?? ""}`.trim()
    : `Credit Invoice ${invoiceNumber ?? ""}`.trim();

  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="space-y-4">
        {classifyRefundId && (
          <p className="text-xs text-muted">
            This refund was issued in Square for{" "}
            <span className="text-strong">{fmtUsd((expectedCents ?? 0) / 100)}</span>. No new money
            moves — choose the lines it came off so the accounts, stock and excise land correctly.
          </p>
        )}

        <fieldset className="space-y-1.5">
          <legend className="text-xs text-muted mb-1">Why?</legend>
          {REASONS.map((r) => (
            <label key={r.value} className="flex gap-2 items-start text-sm cursor-pointer">
              <input
                type="radio"
                name="refund-reason"
                value={r.value}
                checked={reason === r.value}
                onChange={() => setReason(r.value)}
                className="mt-1"
              />
              <span>
                <span className="text-strong">{r.label}</span>
                <span className="block text-[11px] text-muted">{r.blurb}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {loading ? (
          <p className="text-sm text-muted">Loading the invoice&apos;s lines…</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-muted">
              <tr className="border-b border-line">
                <th className="text-left py-1">Line</th>
                <th className="text-right py-1">Billed</th>
                <th className="text-right py-1">Credit</th>
                <th className="text-right py-1">Amount</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const planned = plannedById.get(l.id);
                return (
                  <tr key={l.id} className="border-b border-line/50 last:border-0">
                    <td className="py-1.5">
                      <div className="text-strong">{l.label}</div>
                      {l.basis === "derived" && (
                        <div className="text-[10px] text-faint">
                          Recalculates from the lines you credit
                        </div>
                      )}
                    </td>
                    <td className="py-1.5 text-right text-secondary tabular-nums">
                      {l.basis === "per_unit" ? l.quantity : fmtUsd(l.totalCents / 100)}
                    </td>
                    <td className="py-1.5 text-right">
                      {l.basis === "per_unit" && (
                        <input
                          type="number"
                          min="0"
                          max={l.quantity}
                          step="1"
                          value={qtyById[l.id] ?? ""}
                          onChange={(e) => setQtyById((s) => ({ ...s, [l.id]: e.target.value }))}
                          className="inp-sm w-20 text-right"
                          aria-label={`Credit quantity for ${l.label}`}
                        />
                      )}
                      {l.basis === "flat" && (
                        <input
                          type="checkbox"
                          checked={!!flatOn[l.id]}
                          onChange={(e) => setFlatOn((s) => ({ ...s, [l.id]: e.target.checked }))}
                          aria-label={`Credit ${l.label} in full`}
                        />
                      )}
                      {l.basis === "derived" && <span className="text-faint">auto</span>}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-body">
                      {planned ? fmtUsd(planned.amountCents / 100) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <label className="block">
          <span className="text-xs text-muted">Note (shows on the Square refund)</span>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="inp-sm w-full mt-1"
            placeholder="Optional"
          />
        </label>

        <div className="rounded-lg bg-surface border border-line p-3 space-y-1">
          <div className="flex justify-between text-sm font-semibold">
            <span className="text-body">Credit total</span>
            <span className="text-accent tabular-nums">
              {plan ? fmtUsd(plan.totalCents / 100) : "—"}
            </span>
          </div>
          {plan && (
            <p className="text-[11px] text-muted">
              {plan.recreditsInventory
                ? "Returned units go back into cold storage"
                : "No stock moves"}
              {" · "}
              {plan.reversesExcise ? "excise reverses on the TTB and NC records" : "excise unchanged"}
            </p>
          )}
          {planError && <p className="text-[11px] text-danger">{planError}</p>}
          {mismatch && (
            <p className="text-[11px] text-danger">
              This comes to {fmtUsd((plan?.totalCents ?? 0) / 100)} but Square refunded{" "}
              {fmtUsd((expectedCents ?? 0) / 100)}. Adjust until they agree.
            </p>
          )}
        </div>

        {!classifyRefundId && (
          <p className="text-[10px] text-faint">
            This issues a real Square refund to the customer&apos;s original payment method. It
            cannot be undone from this screen.
          </p>
        )}

        {error && <p className="text-xs text-danger">{error}</p>}

        <div className="flex gap-2 justify-end pt-1">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting || !plan || !!planError || !!mismatch}
            className="btn-primary"
          >
            {submitting
              ? "Working…"
              : classifyRefundId
                ? "Save classification"
                : "Refund & Record"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
