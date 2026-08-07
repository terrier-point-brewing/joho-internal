"use client";

import { useState } from "react";
import { Modal } from "./shared";
import type { DepositCalculation } from "@/lib/square/square-invoices";
import { fmtUsd } from "@/lib/utils/formatting";

export interface MarkPaidData {
  source: "quickbooks" | "other";
  external_ref: string | null;
  paid_at: string;
  amount_cents: number;
}

/** Minimal shape needed to render the deposit invoice modal — satisfied by
 *  both BatchAllocation (Batch Log) and CommitmentAllocationSummary (Commitments). */
export interface DepositInvoiceAllocationLike {
  percentage: number;
  square_deposit_invoice_id?: string | null;
  invoice_generated_at: string | null;
  invoice_paid_at?: string | null;
  contract_brewing_partners?: { company_name: string } | null;
  brew_batches?: { beer_name: string; volume_bbl?: number } | null;
  /** Requested barrelage from the linked commitment — explains how % was derived. */
  commitments?: { volume_bbl: number } | null;
}

export function DepositInvoiceModal({
  allocation,
  preview,
  loading,
  generating,
  onGenerate,
  onMarkPaid,
  markingPaid,
  defaultMode = "generate",
  onClose,
}: {
  allocation: DepositInvoiceAllocationLike;
  preview: { calculation: DepositCalculation } | null;
  loading: boolean;
  generating: boolean;
  onGenerate: () => void;
  onMarkPaid?: (data: MarkPaidData) => void;
  markingPaid?: boolean;
  defaultMode?: "generate" | "mark_paid";
  onClose: () => void;
}) {
  const partner = allocation.contract_brewing_partners;
  const calc = preview?.calculation;
  const isRevision = !!allocation.square_deposit_invoice_id;
  const alreadyPaid = !!allocation.invoice_paid_at;

  const requestedBbl = allocation.commitments?.volume_bbl;
  const batchBbl = allocation.brew_batches?.volume_bbl;
  const pct = Number(allocation.percentage);

  // ── Mark paid form state ───────────────────────────────────────────────────
  const [mode, setMode] = useState<"generate" | "mark_paid">(defaultMode);
  const [mpSource, setMpSource] = useState<"quickbooks" | "other">("quickbooks");
  const [mpRef, setMpRef] = useState("");
  const [mpPaidAt, setMpPaidAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [mpAmount, setMpAmount] = useState("");

  function handleMarkPaidSubmit() {
    const cents = Math.round(parseFloat(mpAmount) * 100);
    if (mpAmount === "" || isNaN(cents) || cents < 0) return;
    onMarkPaid?.({
      source: mpSource,
      external_ref: mpRef.trim() || null,
      paid_at: mpPaidAt,
      amount_cents: cents,
    });
  }

  const mpAmountCents = Math.round(parseFloat(mpAmount) * 100);
  const mpValid = !!mpPaidAt && !isNaN(mpAmountCents) && mpAmountCents >= 0 &&
    (mpSource === "other" || mpRef.trim().length > 0);

  const title = mode === "mark_paid"
    ? "Mark as Paid (External)"
    : isRevision ? "Regenerate Deposit Invoice" : "Generate Deposit Invoice";

  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="space-y-4">

        {/* ── Mark paid form ───────────────────────────────────────────────── */}
        {mode === "mark_paid" ? (
          <>
            <p className="text-xs text-muted">
              Record a deposit payment that was collected outside of Square. This will lock the allocation.
            </p>

            <div className="rounded-lg bg-surface border border-line p-4 space-y-3">
              <div className="space-y-1">
                <label className="text-xs text-secondary">Source</label>
                <select
                  value={mpSource}
                  onChange={(e) => setMpSource(e.target.value as "quickbooks" | "other")}
                  className="inp w-full"
                >
                  <option value="quickbooks">QuickBooks</option>
                  <option value="other">Other</option>
                </select>
              </div>

              {mpSource === "quickbooks" && (
                <div className="space-y-1">
                  <label className="text-xs text-secondary">QB Invoice # <span className="text-danger">*</span></label>
                  <input
                    type="text"
                    value={mpRef}
                    onChange={(e) => setMpRef(e.target.value)}
                    placeholder="e.g. INV-1042"
                    className="inp w-full"
                  />
                </div>
              )}

              {mpSource === "other" && (
                <div className="space-y-1">
                  <label className="text-xs text-secondary">Reference # (optional)</label>
                  <input
                    type="text"
                    value={mpRef}
                    onChange={(e) => setMpRef(e.target.value)}
                    placeholder="e.g. check #1234"
                    className="inp w-full"
                  />
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-secondary">Date paid <span className="text-danger">*</span></label>
                  <input
                    type="date"
                    value={mpPaidAt}
                    onChange={(e) => setMpPaidAt(e.target.value)}
                    className="inp w-full"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-secondary">Amount ($) <span className="text-danger">*</span></label>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={mpAmount}
                    onChange={(e) => setMpAmount(e.target.value)}
                    placeholder="0.00"
                    className="inp w-full"
                  />
                </div>
              </div>
            </div>

            <div className="flex gap-2 justify-between pt-2">
              <button type="button" onClick={() => setMode("generate")}
                className="btn-secondary">
                ← Back
              </button>
              <div className="flex gap-2">
                <button type="button" onClick={onClose} className="btn-secondary">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleMarkPaidSubmit}
                  disabled={markingPaid || !mpValid}
                  className="btn-primary">
                  {markingPaid ? "Saving…" : "Mark Paid"}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            {/* ── Generate mode ─────────────────────────────────────────────── */}
            <div className="rounded-lg bg-surface border border-line p-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted">Partner</span>
                <span className="text-strong font-medium">{partner?.company_name ?? "—"}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted">Batch</span>
                <span className="text-strong">{allocation.brew_batches?.beer_name ?? "—"}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted">Allocation</span>
                <span className="text-strong tabular-nums">{pct.toFixed(1)}%</span>
              </div>
              {requestedBbl != null && batchBbl != null && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted">Barrelage</span>
                  <span className="text-secondary tabular-nums text-right text-xs leading-snug">
                    <span className="text-strong">{requestedBbl.toFixed(2)} BBL</span>
                    <span className="text-faint"> requested ÷ </span>
                    <span className="text-strong">{batchBbl.toFixed(2)} BBL</span>
                    <span className="text-faint"> batch = </span>
                    <span className="text-strong">{pct.toFixed(1)}%</span>
                  </span>
                </div>
              )}
            </div>

            {loading && (
              <p className="text-xs text-muted text-center py-4">Calculating deposit…</p>
            )}

            {calc && !loading && (
              <div className="space-y-3">
                <p className="text-xs font-semibold text-secondary uppercase tracking-wide">Ingredient Cost Breakdown</p>
                <div className="rounded-lg border border-line overflow-hidden">
                  <div className="max-h-72 overflow-y-auto divide-y divide-line/60">
                    {calc.breakdown.map((item, i) => (
                      <div key={i} className="flex justify-between px-3 py-1.5 text-xs">
                        <span className="text-secondary">{item.name}</span>
                        <span className="text-muted tabular-nums ml-4">
                          {item.quantity_per_bbl.toFixed(3)} {item.unit}/BBL × {fmtUsd(item.cost_per_unit_usd)} × {batchBbl?.toFixed(2)} BBL = <span className="text-body">{fmtUsd(item.line_total_usd)}</span>
                        </span>
                      </div>
                    ))}
                    {calc.breakdown.length === 0 && (
                      <p className="text-xs text-faint px-3 py-3">No ingredients with costs found on this recipe.</p>
                    )}
                  </div>

                  <div className="border-t border-line-strong px-3 py-2 bg-surface/60 space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-muted">Total ingredient cost (batch)</span>
                      <span className="text-body tabular-nums">{fmtUsd(calc.total_ingredient_cost_usd)}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-muted">Allocation share ({pct.toFixed(1)}%)</span>
                      <span className="text-body tabular-nums">× {(pct / 100).toFixed(4)}</span>
                    </div>
                    <div className="flex justify-between text-sm font-semibold border-t border-line-strong pt-2 mt-1">
                      <span className="text-body">Ingredient Deposit</span>
                      <span className="text-accent tabular-nums">{fmtUsd(calc.deposit_usd)}</span>
                    </div>
                    <p className="text-[10px] text-faint mt-1">No sales tax charged · payment by card or bank transfer</p>
                  </div>
                </div>

                {isRevision && (
                  <div className="rounded bg-accent-muted/20 border border-accent-border/40 px-3 py-2 text-xs text-accent-soft">
                    A draft invoice already exists in Square. Regenerating will cancel it and create a new one — the invoice will need to be re-sent.
                  </div>
                )}
              </div>
            )}

            {calc && calc.deposit_cents === 0 && (
              <div className="rounded bg-danger-surface/20 border border-danger-border/40 px-3 py-2 text-xs text-danger">
                Deposit amount is $0. Ensure recipe ingredients have costs set before generating.
              </div>
            )}

            <div className="flex gap-2 justify-between pt-2">
              {onMarkPaid && !alreadyPaid ? (
                <button type="button" onClick={() => setMode("mark_paid")}
                  className="btn-secondary">
                  Mark as paid externally
                </button>
              ) : <span />}
              <div className="flex gap-2">
                <button type="button" onClick={onClose} className="btn-secondary">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={onGenerate}
                  disabled={generating || loading || !calc || calc.deposit_cents === 0}
                  className="btn-primary">
                  {generating ? "Generating…" : isRevision ? "Regenerate Invoice" : "Create Draft Invoice"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
