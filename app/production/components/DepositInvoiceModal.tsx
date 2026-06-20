"use client";

import { Modal } from "./shared";
import type { DepositCalculation } from "@/lib/square/deposit-invoices";

/** Minimal shape needed to render the deposit invoice modal — satisfied by
 *  both BatchAllocation (Batch Log) and CommitmentAllocationSummary (Commitments). */
export interface DepositInvoiceAllocationLike {
  percentage: number;
  invoice_generated_at: string | null;
  contract_brewing_partners?: { company_name: string } | null;
  brew_batches?: { beer_name: string } | null;
}

export function DepositInvoiceModal({
  allocation,
  preview,
  loading,
  generating,
  onGenerate,
  onClose,
}: {
  allocation: DepositInvoiceAllocationLike;
  preview: { calculation: DepositCalculation } | null;
  loading: boolean;
  generating: boolean;
  onGenerate: () => void;
  onClose: () => void;
}) {
  const partner = allocation.contract_brewing_partners;
  const calc = preview?.calculation;
  const isRevision = !!allocation.invoice_generated_at;

  return (
    <Modal title={isRevision ? "Revise Deposit Invoice" : "Generate Deposit Invoice"} onClose={onClose}>
      <div className="space-y-4">
        {/* Invoice summary */}
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
            <span className="text-zinc-200 tabular-nums">{Number(allocation.percentage).toFixed(1)}%</span>
          </div>
        </div>

        {/* Deposit calculation */}
        {loading && (
          <p className="text-xs text-zinc-500 text-center py-4">Calculating deposit…</p>
        )}

        {calc && !loading && (
          <div className="space-y-3">
            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Ingredient Cost Breakdown</p>
            <div className="rounded-lg border border-zinc-800 overflow-hidden">
              <div className="max-h-48 overflow-y-auto divide-y divide-zinc-800/60">
                {calc.breakdown.map((item, i) => (
                  <div key={i} className="flex justify-between px-3 py-1.5 text-xs">
                    <span className="text-zinc-400">{item.name}</span>
                    <span className="text-zinc-500 tabular-nums ml-4">
                      {item.quantity_per_bbl.toFixed(2)} {item.unit}/BBL × ${item.cost_per_unit.toFixed(2)} = <span className="text-zinc-300">${item.line_total_usd.toFixed(2)}</span>
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
                  <span className="text-zinc-300 tabular-nums">${calc.total_ingredient_cost_usd.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-zinc-500">Allocation share ({Number(allocation.percentage).toFixed(1)}%)</span>
                  <span className="text-zinc-300 tabular-nums">× {(Number(allocation.percentage) / 100).toFixed(4)}</span>
                </div>
                <div className="flex justify-between text-sm font-semibold border-t border-zinc-700 pt-2 mt-1">
                  <span className="text-zinc-300">Ingredient Deposit</span>
                  <span className="text-amber-400 tabular-nums">${calc.deposit_usd.toFixed(2)}</span>
                </div>
                <p className="text-[10px] text-zinc-600 mt-1">No sales tax charged · payment by card or bank transfer</p>
              </div>
            </div>

            {isRevision && (
              <div className="rounded bg-amber-900/20 border border-amber-800/40 px-3 py-2 text-xs text-amber-300">
                This will cancel the existing draft invoice and create a revised one. The invoice will need to be re-sent.
              </div>
            )}
          </div>
        )}

        {calc && calc.deposit_cents === 0 && (
          <div className="rounded bg-red-900/20 border border-red-800/40 px-3 py-2 text-xs text-red-300">
            Deposit amount is $0. Ensure recipe ingredients have costs set before generating.
          </div>
        )}

        <div className="flex gap-2 justify-end pt-2">
          <button type="button" onClick={onClose}
            className="px-4 py-1.5 text-sm text-zinc-500 hover:text-zinc-300 transition-colors">
            Cancel
          </button>
          <button
            type="button"
            onClick={onGenerate}
            disabled={generating || loading || !calc || calc.deposit_cents === 0}
            className="px-4 py-1.5 text-sm bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded font-medium transition-colors">
            {generating ? "Generating…" : isRevision ? "Revise Draft Invoice" : "Create Draft Invoice"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
