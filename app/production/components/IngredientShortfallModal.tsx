"use client";

import { Modal } from "./shared";
import type { IngredientShortfall } from "@/lib/production/commitments";

interface IngredientShortfallModalProps {
  shortfalls: IngredientShortfall[];
  /** Batch label for the title, e.g. "B-034 · Epic Hazy IPA". */
  batchLabel?: string | null;
  /** Shown above the table when the shortage blocked an action. */
  blockedMessage?: string | null;
  onClose: () => void;
}

// Trailing zeros make a 3-dp quantity table hard to scan, so drop them.
function fmtQty(n: number): string {
  return Number(n.toFixed(3)).toLocaleString("en-US", { maximumFractionDigits: 3 });
}

/**
 * Detail behind an "N ingredients short" warning: for each ingredient, what the
 * batch needs, what is physically on hand, how much of that is still available
 * to this batch once earlier-dated batches take their share, and the resulting
 * shortfall.
 *
 * "Available" is the number that decides the block, and it differs from "On hand"
 * whenever another batch scheduled to brew sooner has already claimed some of the
 * stock — so both are shown rather than leaving the brewer to wonder why a full
 * shelf still reads as short.
 */
export default function IngredientShortfallModal({
  shortfalls, batchLabel, blockedMessage, onClose,
}: IngredientShortfallModalProps) {
  return (
    <Modal title={batchLabel ? `Ingredient shortfall — ${batchLabel}` : "Ingredient shortfall"} onClose={onClose} extraWide>
      <div className="space-y-3">
        {blockedMessage && (
          <div className="rounded border border-danger-border bg-danger-surface/40 px-3 py-2">
            <p className="text-xs text-danger">{blockedMessage}</p>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted uppercase tracking-wide border-b border-line">
                <th className="py-1.5 pr-3 font-semibold">Ingredient</th>
                <th className="py-1.5 px-3 font-semibold text-right">Needed</th>
                <th className="py-1.5 px-3 font-semibold text-right">On hand</th>
                <th className="py-1.5 px-3 font-semibold text-right">Available</th>
                <th className="py-1.5 pl-3 font-semibold text-right">Short by</th>
              </tr>
            </thead>
            <tbody>
              {shortfalls.map((s) => (
                <tr key={s.ingredient_id} className="border-b border-line-subtle last:border-0">
                  <td className="py-1.5 pr-3 text-primary">{s.name}</td>
                  <td className="py-1.5 px-3 text-right text-body tabular-nums">
                    {fmtQty(s.this_batch_committed)} <span className="text-faint">{s.unit}</span>
                  </td>
                  <td className="py-1.5 px-3 text-right text-body tabular-nums">
                    {fmtQty(s.stock_quantity)} <span className="text-faint">{s.unit}</span>
                  </td>
                  <td className="py-1.5 px-3 text-right text-secondary tabular-nums">
                    {fmtQty(s.available_to_batch)} <span className="text-faint">{s.unit}</span>
                  </td>
                  <td className="py-1.5 pl-3 text-right text-danger font-medium tabular-nums">
                    {fmtQty(s.shortfall)} <span className="text-danger/70">{s.unit}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {shortfalls.some((s) => s.available_to_batch < s.stock_quantity) && (
          <p className="text-xs text-faint">
            &ldquo;Available&rdquo; is below &ldquo;On hand&rdquo; where another batch scheduled to brew
            sooner has already claimed part of the stock. Re-date or cancel that batch to free it up.
          </p>
        )}

        <div className="flex justify-end pt-1">
          <button type="button" onClick={onClose} className="btn-secondary">Close</button>
        </div>
      </div>
    </Modal>
  );
}
