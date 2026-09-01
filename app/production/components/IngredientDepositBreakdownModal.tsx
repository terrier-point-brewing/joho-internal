"use client";

import { Modal } from "./shared";
import Banner from "@/app/components/ui/Banner";
import { formatCurrencyCents, formatNumber, formatUnitCost } from "@/lib/format";
import type { ShippedDepositLine } from "@/lib/production/exportIngredientDeposit";

// Ingredient quantities span four orders of magnitude on one bill — 695 lb of
// silo malt next to 1.06 lb of Zeus — so small numbers keep their decimals and
// large ones stay readable.
function fmtQty(n: number): string {
  if (Number.isInteger(n)) return formatNumber(n);
  return formatNumber(n, n < 10 ? 3 : 2);
}

/**
 * Read-only derivation of an Ingredient Deposit invoice line: the batch's whole
 * ingredient bill, and the slice of it this shipment is being charged for.
 *
 * The mirror of PackagingMaterialsBreakdownModal, and it exists for the same
 * reason — a partner asked to pay several hundred dollars of "Ingredient
 * Deposit" is entitled to see the grain behind it, and the operator should not
 * have to reconstruct the arithmetic from the recipe card before sending the
 * invoice.
 *
 * The share column sums to the charge exactly (largest-remainder, in
 * `allocateShares`), so the two totals at the foot always tie.
 */
export default function IngredientDepositBreakdownModal({
  line,
  onClose,
}: {
  line: ShippedDepositLine;
  onClose: () => void;
}) {
  const excluded = line.excludedRecipes.map((r) => r.beerName);
  const basis = line.packagingInProgress ? "projected yield" : "packaged";

  return (
    <Modal title={`Ingredient Deposit — ${line.beerName}`} onClose={onClose} wide>
      <div className="space-y-4">
        <p className="text-xs text-muted">
          Billed at cost — this shipment&rsquo;s share of what the batch&rsquo;s ingredients cost. No markup is
          applied.
        </p>

        {/* ── How the share was arrived at ─────────────────────────────────── */}
        <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
            <span className="text-secondary">
              {line.beerName}
              {line.batchNumber && <span className="text-faint"> · {line.batchNumber}</span>}
            </span>
            <span className="text-faint">—</span>
            <span className="tabular-nums text-body">{line.shippedBbl.toFixed(2)} bbl shipped</span>
            <span className="text-faint">of</span>
            <span className="tabular-nums text-body">
              {line.projectedYieldBbl.toFixed(2)} bbl {basis}
            </span>
            <span className="text-faint">=</span>
            <span className="tabular-nums font-medium text-strong">{line.percentage.toFixed(2)}%</span>
          </div>
          <p className="text-2xs text-faint mt-1.5">
            The denominator is what the batch yields, not what was brewed — beer is lost between the tank and
            the package, and whoever took beer out of the batch shares that loss.
            {line.inTankBbl > 0.01 && (
              <>
                {" "}
                {line.inTankBbl.toFixed(2)} bbl is still in tank, so the yield is projected and this share errs
                low; it rises slightly once that beer is packaged.
              </>
            )}
          </p>
        </div>

        {excluded.length > 0 && (
          <Banner tone="accent">
            Conversion additions only — the ingredients of {excluded.join(" and ")} are left out, because that
            beer was bought and charged against the batch this liquid was drawn off. Only what the conversion
            added is billed here.
          </Banner>
        )}

        {/* ── The bill ─────────────────────────────────────────────────────── */}
        <div className="rounded-lg border border-line overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-2xs uppercase tracking-wide text-faint bg-surface-mid">
                  <th className="text-left font-medium px-3 py-1.5">Ingredient</th>
                  <th className="text-right font-medium px-3 py-1.5">Unit cost</th>
                  <th className="text-right font-medium px-3 py-1.5">Batch qty</th>
                  <th className="text-right font-medium px-3 py-1.5">Batch cost</th>
                  <th className="text-right font-medium px-3 py-1.5">
                    Share ({line.percentage.toFixed(2)}%)
                  </th>
                </tr>
              </thead>
              <tbody>
                {line.breakdown.map((b) => (
                  <tr key={b.ingredientId} className="border-t border-line-subtle">
                    <td className="px-3 py-1.5 text-body">{b.name}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-secondary">
                      {formatUnitCost(b.costPerUnitUsd)}
                      {b.unit && <span className="text-faint">/{b.unit}</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-secondary">
                      {fmtQty(b.batchQuantity)}
                      {b.unit && <span className="text-faint ml-0.5">{b.unit}</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-secondary">
                      {formatCurrencyCents(Math.round(b.batchCostUsd * 100))}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-body">
                      {formatCurrencyCents(b.shareCents)}
                    </td>
                  </tr>
                ))}
                {line.breakdown.length === 0 && (
                  <tr className="border-t border-line-subtle">
                    <td colSpan={5} className="px-3 py-1.5 text-faint">
                      No priced ingredients on this bill.
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="border-t border-line">
                  <td colSpan={3} className="px-3 py-1.5 text-secondary">
                    {excluded.length > 0 ? "Ingredient bill (additions only)" : "Ingredient bill"}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums font-medium text-strong">
                    {formatCurrencyCents(Math.round(line.totalIngredientCostUsd * 100))}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums font-medium text-strong">
                    {formatCurrencyCents(line.depositCents)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-line">
          <span className="text-sm text-secondary">Line total</span>
          <span className="text-sm font-medium text-primary tabular-nums">
            {formatCurrencyCents(line.depositCents)}
          </span>
        </div>

        <div className="flex justify-end">
          <button onClick={onClose} className="btn-secondary">Close</button>
        </div>
      </div>
    </Modal>
  );
}
