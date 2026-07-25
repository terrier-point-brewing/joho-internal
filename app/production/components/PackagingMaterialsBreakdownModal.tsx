"use client";

import { Modal } from "./shared";
import Banner from "@/app/components/ui/Banner";
import { formatCurrencyCents, formatNumber, formatUnitCost } from "@/lib/format";
import type { MaterialLineBreakdown } from "@/lib/production/exportInvoicePreview";
import type { MaterialRole } from "@/lib/production/packagingMaterials";

const ROLE_LABEL: Record<MaterialRole, string> = {
  container: "Container",
  lid: "Lid",
  label: "Label",
  paktech: "PakTech",
  tray: "Tray",
};

const FORMAT_LABEL: Record<string, string> = {
  loose: "Loose",
  "4-pack": "4-Pack",
  "6-pack": "6-Pack",
  case: "Case",
};

// Package counts can be fractional (a partial case), so show up to 4 decimals
// but drop trailing zeros — 16 stays "16", 5.8034 keeps its precision.
function fmtQty(n: number): string {
  if (Number.isInteger(n)) return formatNumber(n);
  return formatNumber(n, 4).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Read-only derivation of a Packaging Materials invoice line: for each packaging
 * run on the line, every component consumed × its unit cost. Opened from the
 * invoice preview so the user can see where the charge came from before sending
 * it to a customer. Purely informational — editing happens on the line itself.
 */
export default function PackagingMaterialsBreakdownModal({
  breakdown,
  onClose,
}: {
  breakdown: MaterialLineBreakdown;
  onClose: () => void;
}) {
  const title = breakdown.beerName
    ? `Packaging Materials — ${breakdown.beerName}`
    : "Packaging Materials";

  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="space-y-4">
        <p className="text-xs text-muted">
          Billed at cost — the sum of every packaging component consumed, at its unit cost. No markup is applied.
        </p>

        {breakdown.missingCostNames.length > 0 && (
          <Banner tone="accent">
            No unit cost is set for {breakdown.missingCostNames.join(", ")} — billed at $0. Set costs under
            Production → Packaging → Items.
          </Banner>
        )}

        {breakdown.transactions.map((txn, i) => (
          <div key={i} className="rounded-lg border border-line overflow-hidden">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3 py-2 bg-surface-mid border-b border-line">
              <span className="text-xs font-medium text-strong">{txn.label ?? "Packaging run"}</span>
              <span className="text-2xs text-muted tabular-nums">
                {fmtQty(txn.packages)} × {FORMAT_LABEL[txn.format] ?? txn.format}
                {txn.unitsPerPackage > 1 ? ` @ ${fmtQty(txn.unitsPerPackage)} units` : ""}
              </span>
            </div>

            <table className="w-full text-xs">
              <thead>
                <tr className="text-2xs uppercase tracking-wide text-faint">
                  <th className="text-left font-medium px-3 py-1.5">Component</th>
                  <th className="text-right font-medium px-3 py-1.5">Unit cost</th>
                  <th className="text-right font-medium px-3 py-1.5">Qty used</th>
                  <th className="text-right font-medium px-3 py-1.5">Cost</th>
                </tr>
              </thead>
              <tbody>
                {txn.components.map((c, j) => (
                  <tr key={j} className="border-t border-line-subtle">
                    <td className="px-3 py-1.5">
                      <span className="text-body">{c.name}</span>
                      <span className="text-faint ml-1.5">{ROLE_LABEL[c.role]}</span>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {c.missingCost ? (
                        <span className="text-danger">no cost set</span>
                      ) : (
                        <span className="text-secondary">{formatUnitCost(c.unitCostDollars)}</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-secondary">{formatNumber(c.quantity)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-body">{formatCurrencyCents(c.extendedCents)}</td>
                  </tr>
                ))}
                {txn.components.length === 0 && (
                  <tr className="border-t border-line-subtle">
                    <td colSpan={4} className="px-3 py-1.5 text-faint">
                      No priced components consumed.
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="border-t border-line">
                  <td colSpan={3} className="px-3 py-1.5 text-secondary">Subtotal</td>
                  <td className="px-3 py-1.5 text-right tabular-nums font-medium text-strong">
                    {formatCurrencyCents(txn.subtotalCents)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        ))}

        <div className="flex items-center justify-between pt-2 border-t border-line">
          <span className="text-sm text-secondary">Line total</span>
          <span className="text-sm font-medium text-primary tabular-nums">
            {formatCurrencyCents(breakdown.totalCents)}
          </span>
        </div>

        <div className="flex justify-end">
          <button onClick={onClose} className="btn-secondary">Close</button>
        </div>
      </div>
    </Modal>
  );
}
