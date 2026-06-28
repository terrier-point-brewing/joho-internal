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
            <p className="text-xs text-zinc-500">
              Record a deposit payment that was collected outside of Square. This will lock the allocation.
            </p>

            <div className="rounded-lg bg-zinc-900 border border-zinc-800 p-4 space-y-3">
              <div className="space-y-1">
                <label className="text-xs text-zinc-400">Source</label>
                <select
                  value={mpSource}
                  onChange={(e) => setMpSource(e.target.value as "quickbooks" | "other")}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200"
                >
                  <option value="quickbooks">QuickBooks</option>
                  <option value="other">Other</option>
                </select>
              </div>

              {mpSource === "quickbooks" && (
                <div className="space-y-1">
                  <label className="text-xs text-zinc-400">QB Invoice # <span className="text-red-400">*</span></label>
                  <input
                    type="text"
                    value={mpRef}
                    onChange={(e) => setMpRef(e.target.value)}
                    placeholder="e.g. INV-1042"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600"
                  />
                </div>
              )}

              {mpSource === "other" && (
                <div className="space-y-1">
                  <label className="text-xs text-zinc-400">Reference # (optional)</label>
                  <input
                    type="text"
                    value={mpRef}
                    onChange={(e) => setMpRef(e.target.value)}
                    placeholder="e.g. check #1234"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600"
                  />
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-zinc-400">Date paid <span className="text-red-400">*</span></label>
                  <input
                    type="date"
                    value={mpPaidAt}
                    onChange={(e) => setMpPaidAt(e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-zinc-400">Amount ($) <span className="text-red-400">*</span></label>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={mpAmount}
                    onChange={(e) => setMpAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600"
                  />
                </div>
              </div>
            </div>

            <div className="flex gap-2 justify-between pt-2">
              <button type="button" onClick={() => setMode("generate")}
                className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
                ← Back
              </button>
              <div className="flex gap-2">
                <button type="button" onClick={onClose}
                  className="px-4 py-1.5 text-sm text-zinc-500 hover:text-zinc-300 transition-colors">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleMarkPaidSubmit}
                  disabled={markingPaid || !mpValid}
                  className="px-4 py-1.5 text-sm bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white rounded font-medium transition-colors">
                  {markingPaid ? "Saving…" : "Mark Paid"}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            {/* ── Generate mode ─────────────────────────────────────────────── */}
            <div className="rounded-lg bg-zinc-900 border border-zinc-800 p-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-zinc-500">Partner</span>
                <span className="text-zinc-200 font-medium">{partner?.company_name ?? "—"}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-zinc-500">Batch</span>
                <span className="text-zinc-200">{allocation.brew_batches?.beer_name ?? "—"}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-zinc-500">Allocation</span>
                <span className="text-zinc-200 tabular-nums">{pct.toFixed(1)}%</span>
              </div>
              {requestedBbl != null && batchBbl != null && (
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-500">Barrelage</span>
                  <span className="text-zinc-400 tabular-nums text-right text-xs leading-snug">
                    <span className="text-zinc-200">{requestedBbl.toFixed(2)} BBL</span>
                    <span className="text-zinc-600"> requested ÷ </span>
                    <span className="text-zinc-200">{batchBbl.toFixed(2)} BBL</span>
                    <span className="text-zinc-600"> batch = </span>
                    <span className="text-zinc-200">{pct.toFixed(1)}%</span>
                  </span>
                </div>
              )}
            </div>

            {loading && (
              <p className="text-xs text-zinc-500 text-center py-4">Calculating deposit…</p>
            )}

            {calc && !loading && (
              <div className="space-y-3">
                <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Ingredient Cost Breakdown</p>
                <div className="rounded-lg border border-zinc-800 overflow-hidden">
                  <div className="max-h-72 overflow-y-auto divide-y divide-zinc-800/60">
                    {calc.breakdown.map((item, i) => (
                      <div key={i} className="flex justify-between px-3 py-1.5 text-xs">
                        <span className="text-zinc-400">{item.name}</span>
                        <span className="text-zinc-500 tabular-nums ml-4">
                          {item.quantity_per_bbl.toFixed(2)} {item.unit}/BBL × {fmtUsd(item.cost_per_unit)} = <span className="text-zinc-300">{fmtUsd(item.line_total_usd)}</span>
                        </span>
                      </div>
                    ))}
                    {calc.breakdown.length === 0 && (
                      <p className="text-xs text-zinc-600 px-3 py-3">No ingredients with costs found on this recipe.</p>
                    )}
                  </div>

                  <div className="border-t border-zinc-700 px-3 py-2 bg-zinc-900/60 space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-zinc-500">Total ingredient cost (batch)</span>
                      <span className="text-zinc-300 tabular-nums">{fmtUsd(calc.total_ingredient_cost_usd)}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-zinc-500">Allocation share ({pct.toFixed(1)}%)</span>
                      <span className="text-zinc-300 tabular-nums">× {(pct / 100).toFixed(4)}</span>
                    </div>
                    <div className="flex justify-between text-sm font-semibold border-t border-zinc-700 pt-2 mt-1">
                      <span className="text-zinc-300">Ingredient Deposit</span>
                      <span className="text-amber-400 tabular-nums">{fmtUsd(calc.deposit_usd)}</span>
                    </div>
                    <p className="text-[10px] text-zinc-600 mt-1">No sales tax charged · payment by card or bank transfer</p>
                  </div>
                </div>

                {isRevision && (
                  <div className="rounded bg-amber-900/20 border border-amber-800/40 px-3 py-2 text-xs text-amber-300">
                    A draft invoice already exists in Square. Regenerating will cancel it and create a new one — the invoice will need to be re-sent.
                  </div>
                )}
              </div>
            )}

            {calc && calc.deposit_cents === 0 && (
              <div className="rounded bg-red-900/20 border border-red-800/40 px-3 py-2 text-xs text-red-300">
                Deposit amount is $0. Ensure recipe ingredients have costs set before generating.
              </div>
            )}

            <div className="flex gap-2 justify-between pt-2">
              {onMarkPaid && !alreadyPaid ? (
                <button type="button" onClick={() => setMode("mark_paid")}
                  className="text-xs text-zinc-500 hover:text-zinc-300 underline underline-offset-2 transition-colors">
                  Mark as paid externally
                </button>
              ) : <span />}
              <div className="flex gap-2">
                <button type="button" onClick={onClose}
                  className="px-4 py-1.5 text-sm text-zinc-500 hover:text-zinc-300 transition-colors">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={onGenerate}
                  disabled={generating || loading || !calc || calc.deposit_cents === 0}
                  className="px-4 py-1.5 text-sm bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded font-medium transition-colors">
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
