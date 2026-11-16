"use client";

import ListTable from "@/app/components/ui/ListTable";
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

        <ListTable<(typeof shortfalls)[number]>
          dense
          zebra={false}
          rows={shortfalls}
          rowKey={(s) => s.ingredient_id}
          cols={[
            { key: "name", header: "Ingredient", role: "label", className: "!font-normal", cell: (s) => s.name },
            { key: "needed", header: "Needed", align: "right", foldLabel: "Needed", className: "text-body tabular-nums", cell: (s) => <span>{fmtQty(s.this_batch_committed)} <span className="text-faint">{s.unit}</span></span> },
            { key: "onhand", header: "On hand", align: "right", foldLabel: "On hand", className: "text-body tabular-nums", cell: (s) => <span>{fmtQty(s.stock_quantity)} <span className="text-faint">{s.unit}</span></span> },
            { key: "available", header: "Available", align: "right", foldLabel: "Available", className: "text-secondary tabular-nums", cell: (s) => <span>{fmtQty(s.available_to_batch)} <span className="text-faint">{s.unit}</span></span> },
            { key: "short", header: "Short by", role: "headline", align: "right", className: "text-danger font-medium tabular-nums", cell: (s) => <span>{fmtQty(s.shortfall)} <span className="text-danger/70">{s.unit}</span></span> },
          ]}
        />

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
