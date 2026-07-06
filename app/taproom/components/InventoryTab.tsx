"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import type {
  InventoryGrid,
  InventoryRow,
  InventoryCell,
  InventoryCellVariation,
} from "@/lib/production/inventoryGrid";
import type { MappingColumn } from "@/app/production/types";

// ── formatting ────────────────────────────────────────────────────────────────

const fmtBbl = (n: number) => n.toFixed(2);

// Whole counts render clean; partial counts (rare) keep one decimal.
const fmtCount = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function pluralize(n: number, one: string, many: string) {
  return n === 1 ? one : many;
}

// Short label for a variation within a multi-variation cell — strips the column
// context, mirroring the Square-mapping grid so the two views read the same.
function varLabel(variationName: string, colLabel: string): string {
  if (variationName === colLabel) return "Standard";
  if (variationName === `Standard ${colLabel}`) return "Standard";
  const suffix = ` - ${colLabel}`;
  if (variationName.endsWith(suffix)) return variationName.slice(0, -suffix.length);
  return variationName;
}

// ── quantity card ─────────────────────────────────────────────────────────────

function QuantityCard({
  v,
  label,
}: {
  v: InventoryCellVariation;
  label: string | null;
}) {
  // Draft has no discrete count — barrelage IS the headline number. Keg/can lead
  // with the container count and show barrelage as the supporting figure.
  const isDraft = v.packaging === "draft";
  const headline = isDraft ? fmtBbl(v.currentBbl) : fmtCount(v.currentQty);
  const unit = isDraft
    ? "bbl on tap"
    : v.packaging === "keg"
      ? pluralize(v.currentQty, "keg", "kegs")
      : pluralize(v.currentQty, "can", "cans");

  return (
    <div className="rounded-md border border-accent-border/30 bg-accent-muted/20 px-2 py-1.5">
      {label && <div className="text-[9px] text-accent-soft mb-0.5 leading-none">{label}</div>}
      <div className="flex items-baseline gap-1">
        <span className="text-base font-semibold text-accent-emphasis leading-none tabular-nums">{headline}</span>
        <span className="text-[10px] text-muted">{unit}</span>
      </div>
      {!isDraft && (
        <div className="text-[10px] text-secondary mt-0.5 tabular-nums">{fmtBbl(v.currentBbl)} bbl</div>
      )}
    </div>
  );
}

function Cell({ cell, col }: { cell: InventoryCell | null | undefined; col: MappingColumn }) {
  // Structural empty — recipe has no variation for this column.
  if (cell === null || cell === undefined) {
    return <td className="px-3 py-2.5 text-center text-disabled">—</td>;
  }

  const stocked = cell.variations.filter((v) => v.currentQty > 0);

  // Linked but nothing on hand — de-emphasize so available inventory stands out.
  if (stocked.length === 0) {
    return <td className="px-3 py-2.5 text-center text-faint">—</td>;
  }

  const multi = stocked.length > 1;

  return (
    <td className="px-3 py-2.5 align-top">
      <div className="flex flex-col gap-1">
        {stocked.map((v) => (
          <QuantityCard key={v.variationId} v={v} label={multi ? varLabel(v.variationName, col.label) : null} />
        ))}
        {multi && (
          <div className="text-[10px] text-secondary text-right tabular-nums pr-0.5">
            {fmtBbl(cell.totalBbl)} bbl
          </div>
        )}
      </div>
    </td>
  );
}

// ── grid ──────────────────────────────────────────────────────────────────────

export default function InventoryTab() {
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.taproom.inventory(),
    queryFn: () => fetchJson<InventoryGrid>("/api/taproom/inventory"),
  });

  if (isLoading) return <div className="text-sm text-muted py-8 text-center">Loading inventory…</div>;
  if (error) return <div className="text-sm text-danger py-8 text-center">{(error as Error).message}</div>;
  if (!data) return null;

  const { columns, rows, columnTotals, grandTotalBbl } = data;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between rounded-lg border border-accent-border/30 bg-accent-muted/20 px-4 py-2.5">
        <span className="text-sm text-body">Cold storage available to the taproom</span>
        <span className="text-sm text-strong font-semibold tabular-nums">
          {fmtBbl(grandTotalBbl)} bbl total
        </span>
      </div>

      <div className="overflow-x-auto overflow-y-auto max-h-[calc(100vh-200px)] rounded-lg border border-line">
        <table className="text-xs border-collapse" style={{ tableLayout: "fixed", width: "max-content", minWidth: "100%" }}>
          <colgroup>
            <col style={{ width: 200 }} />
            {columns.map((col) => (
              <col key={col.key} style={{ width: 180 }} />
            ))}
            <col style={{ width: 110 }} />
          </colgroup>
          <thead>
            <tr className="border-b border-line">
              <th className="sticky left-0 top-0 z-30 bg-surface px-4 py-2.5 text-left font-semibold text-secondary whitespace-nowrap">
                Recipe
              </th>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className="sticky top-0 z-20 bg-surface px-3 py-2.5 text-left font-medium text-secondary whitespace-nowrap"
                >
                  {col.label}
                </th>
              ))}
              <th className="sticky right-0 top-0 z-30 bg-surface px-3 py-2.5 text-right font-semibold text-secondary whitespace-nowrap border-l border-line/40">
                Total (BBL)
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.flatMap((row: InventoryRow, i) => {
              const showHeader = i === 0 || row.recipePartnerName !== rows[i - 1].recipePartnerName;
              const header = showHeader ? (
                <tr key={`group-${row.recipePartnerName ?? "house"}`}>
                  <td
                    colSpan={columns.length + 2}
                    className="px-4 py-1 text-[10px] font-semibold uppercase tracking-widest text-faint bg-surface/40 border-b border-line/40"
                  >
                    {row.recipePartnerName ?? "House"}
                  </td>
                </tr>
              ) : null;

              const empty = row.totalBbl === 0;

              return [
                header,
                <tr key={row.recipeId} className="border-b border-line/40 hover:bg-surface/20 transition-colors">
                  <td className="sticky left-0 z-10 bg-canvas px-4 py-2.5 font-medium text-strong whitespace-nowrap border-r border-line/40 overflow-hidden text-ellipsis">
                    {row.recipeName}
                  </td>
                  {columns.map((col) => (
                    <Cell key={col.key} cell={row.cells[col.key]} col={col} />
                  ))}
                  <td
                    className={`sticky right-0 z-10 bg-canvas px-3 py-2.5 text-right font-semibold tabular-nums border-l border-line/40 ${
                      empty ? "text-faint" : "text-strong"
                    }`}
                  >
                    {fmtBbl(row.totalBbl)}
                  </td>
                </tr>,
              ];
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-line-strong bg-surface sticky bottom-0 z-20">
              <td className="sticky left-0 z-30 bg-surface px-4 py-2.5 text-left font-semibold text-secondary whitespace-nowrap border-r border-line/40">
                Total (BBL)
              </td>
              {columns.map((col) => (
                <td key={col.key} className="px-3 py-2.5 text-left font-semibold text-body tabular-nums">
                  {fmtBbl(columnTotals[col.key] ?? 0)}
                </td>
              ))}
              <td className="sticky right-0 z-30 bg-surface px-3 py-2.5 text-right font-bold text-accent-emphasis tabular-nums border-l border-line/40">
                {fmtBbl(grandTotalBbl)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
