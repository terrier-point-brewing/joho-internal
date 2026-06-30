"use client";

import { Modal } from "./shared";
import type { BatchAllocation } from "../types";
import { fmtUsd } from "@/lib/utils/formatting";

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

  const fmt = (cents: number) => fmtUsd(cents / 100);

  return (
    <Modal title="Reduce Allocation & Refund" onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-lg bg-surface border border-line p-4 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted">Originally paid ({currentPercentage.toFixed(1)}%)</span>
            <span className="text-strong tabular-nums">{fmt(paidCents)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted">New deposit at {newPercentage.toFixed(1)}%</span>
            <span className="text-strong tabular-nums">{fmt(newDepositCents)}</span>
          </div>
          <div className="flex justify-between text-sm font-semibold border-t border-line-strong pt-2 mt-1">
            <span className="text-body">Refund due</span>
            <span className="text-accent tabular-nums">{fmt(refundCents)}</span>
          </div>
        </div>

        <p className="text-[10px] text-faint">
          This will issue a real Square refund to the partner&apos;s original payment method, then save the new percentage. This cannot be undone from this screen.
        </p>

        <div className="flex gap-2 justify-end pt-2">
          <button type="button" onClick={onClose}
            className="px-4 py-1.5 text-sm text-muted hover:text-body transition-colors">
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting}
            className="px-4 py-1.5 text-sm bg-accent-emphasis hover:bg-accent-emphasis disabled:opacity-50 text-primary rounded font-medium transition-colors">
            {submitting ? "Refunding…" : "Refund & Save"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
