"use client";

import { Modal } from "./shared";
import type { BatchAllocation } from "../types";

/**
 * Shown when a brewer reduces the percentage on a locked, paid allocation.
 * Refund math mirrors the server's proportional formula exactly so the
 * preview here matches what /adjust will actually charge back — but this
 * is display-only; the server recomputes independently before refunding.
 */
export function RefundAdjustmentModal({
  allocation,
  newPercentage,
  submitting,
  onConfirm,
  onClose,
}: {
  allocation: BatchAllocation;
  newPercentage: number;
  submitting: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const paidCents = allocation.deposit_amount_paid_cents ?? 0;
  const currentPercentage = Number(allocation.percentage);
  const newDepositCents = Math.round(paidCents * (newPercentage / currentPercentage));
  const refundCents = paidCents - newDepositCents;

  const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  return (
    <Modal title="Reduce Allocation & Refund" onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-lg bg-zinc-900 border border-zinc-800 p-4 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-zinc-500">Originally paid ({currentPercentage.toFixed(1)}%)</span>
            <span className="text-zinc-200 tabular-nums">{fmt(paidCents)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-zinc-500">New deposit at {newPercentage.toFixed(1)}%</span>
            <span className="text-zinc-200 tabular-nums">{fmt(newDepositCents)}</span>
          </div>
          <div className="flex justify-between text-sm font-semibold border-t border-zinc-700 pt-2 mt-1">
            <span className="text-zinc-300">Refund due</span>
            <span className="text-amber-400 tabular-nums">{fmt(refundCents)}</span>
          </div>
        </div>

        <p className="text-[10px] text-zinc-600">
          This will issue a real Square refund to the partner&apos;s original payment method, then save the new percentage. This cannot be undone from this screen.
        </p>

        <div className="flex gap-2 justify-end pt-2">
          <button type="button" onClick={onClose}
            className="px-4 py-1.5 text-sm text-zinc-500 hover:text-zinc-300 transition-colors">
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting}
            className="px-4 py-1.5 text-sm bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded font-medium transition-colors">
            {submitting ? "Refunding…" : "Refund & Save"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
