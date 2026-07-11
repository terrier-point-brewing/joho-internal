"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import Banner from "@/app/components/ui/Banner";
import { useTableControls } from "@/app/components/ui/useTableControls";
import SearchInput from "@/app/components/ui/SearchInput";
import FilterSelect from "@/app/components/ui/FilterSelect";
import FilterBar from "@/app/components/ui/FilterBar";
import type { ControlsConfig } from "@/lib/table/types";
import type {
  InventoryGrid,
  InventoryRow,
  InventoryCell,
  InventoryCellVariation,
} from "@/lib/production/inventoryGrid";
import type { MappingColumn } from "@/app/production/types";

interface ReconEvent {
  recipe_id: string | null;
  base_variation_name: string | null;
  cold_storage_cans: number;
  square_cans_before: number;
  drift: number;
  occurred_at: string;
}
type TaproomInventoryResponse = InventoryGrid & { reconciliations: ReconEvent[] };

const INVENTORY_CONTROLS: ControlsConfig<InventoryRow> = {
  search: [{ param: "q", accessor: (r) => r.recipeName }],
  filters: [{ param: "partner", accessor: (r) => r.recipePartnerName ?? "House" }],
};

// ── formatting ────────────────────────────────────────────────────────────────

const fmtBbl = (n: number) => n.toFixed(2);

// Whole counts render clean; partial counts (rare) keep one decimal.
const fmtCount = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function pluralize(n: number, one: string, many: string) {
  return n === 1 ? one : many;
}

// Noun for a packaged unit, by cold-storage format. A case is a case — not a can.
function packagedUnit(format: string | null, n: number): string {
  switch (format) {
    case "case":   return pluralize(n, "case", "cases");
    case "4-pack": return pluralize(n, "4-pack", "4-packs");
    case "6-pack": return pluralize(n, "6-pack", "6-packs");
    case "loose":  return pluralize(n, "can", "cans");
    default:       return pluralize(n, "unit", "units");
  }
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
      : packagedUnit(v.format, v.currentQty);

  return (
    <div className="rounded-md border border-accent-border/30 bg-accent-muted/20 px-1.5 py-1">
      {label && <div className="text-[9px] text-accent-soft leading-none">{label}</div>}
      <div className="flex items-baseline gap-1">
        <span className="text-sm font-semibold text-accent-emphasis leading-none tabular-nums">{headline}</span>
        <span className="text-[10px] text-muted">{unit}</span>
      </div>
      {!isDraft && (
        <div className="text-[10px] text-secondary tabular-nums leading-tight">{fmtBbl(v.currentBbl)} bbl</div>
      )}
    </div>
  );
}

function Cell({ cell, col }: { cell: InventoryCell | null | undefined; col: MappingColumn }) {
  // Structural empty — recipe has no variation for this column.
  if (cell === null || cell === undefined) {
    return <td className="px-2 py-1.5 text-center text-disabled">—</td>;
  }

  const stocked = cell.variations.filter((v) => v.currentQty > 0);

  // Linked but nothing on hand — de-emphasize so available inventory stands out.
  if (stocked.length === 0) {
    return <td className="px-2 py-1.5 text-center text-faint">—</td>;
  }

  const multi = stocked.length > 1;

  return (
    <td className="px-2 py-1.5 align-top">
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
    queryFn: () => fetchJson<TaproomInventoryResponse>("/api/taproom/inventory"),
  });

  const source = useMemo(() => data?.rows ?? [], [data?.rows]);
  const { rows, search, filters, setSearch, setFilter, reset, activeCount } =
    useTableControls(source, INVENTORY_CONTROLS);

  const partnerOptions = useMemo(
    () =>
      Array.from(new Set(source.map((r) => r.recipePartnerName ?? "House")))
        .sort()
        .map((p) => ({ value: p, label: p })),
    [source],
  );

  const lastReconcile = useMemo(() => {
    const events = data?.reconciliations ?? [];
    if (events.length === 0) return null;
    const latest = events[0].occurred_at;
    // Count corrections from the most recent reconcile batch (same occurred_at).
    const inBatch = events.filter((e) => e.occurred_at === latest);
    return { at: latest, count: inBatch.length };
  }, [data]);

  // Column/grand totals recomputed from the matches so the banner and footer
  // track what's visible.
  const { columnTotals, grandTotalBbl } = useMemo(() => {
    const cols = data?.columns ?? [];

    const columnTotals: Record<string, number> = Object.fromEntries(cols.map((c) => [c.key, 0]));
    let grandTotalBbl = 0;
    for (const r of rows) {
      grandTotalBbl += r.totalBbl;
      for (const col of cols) {
        const cell = r.cells[col.key];
        if (cell) columnTotals[col.key] += cell.totalBbl;
      }
    }
    for (const k of Object.keys(columnTotals)) columnTotals[k] = Number(columnTotals[k].toFixed(2));
    return { columnTotals, grandTotalBbl: Number(grandTotalBbl.toFixed(2)) };
  }, [rows, data?.columns]);

  if (isLoading) return <div className="text-sm text-muted py-8 text-center">Loading inventory…</div>;
  if (error) return <div className="text-sm text-danger py-8 text-center">{(error as Error).message}</div>;
  if (!data) return null;

  const { columns } = data;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between rounded-lg border border-accent-border/30 bg-accent-muted/20 px-3 py-2">
        <span className="text-sm text-body">Cold storage available to the taproom</span>
        <span className="text-sm text-strong font-semibold tabular-nums">
          {fmtBbl(grandTotalBbl)} bbl{activeCount > 0 ? " shown" : " total"}
        </span>
      </div>

      {lastReconcile && (
        <Banner tone="info" className="mb-2">
          Square inventory is auto-synced from cold storage. Last correction{" "}
          {new Date(lastReconcile.at).toLocaleString()} — {lastReconcile.count}{" "}
          {pluralize(lastReconcile.count, "SKU", "SKUs")} adjusted to match cold storage.
        </Banner>
      )}

      <div className="mb-2 flex items-center gap-2">
        <FilterBar activeCount={activeCount} onClear={reset}>
          <SearchInput
            value={search.q ?? ""}
            onChange={(v) => setSearch("q", v)}
            placeholder="Search recipes…"
          />
          <FilterSelect
            label="Partner"
            options={partnerOptions}
            value={filters.partner ?? []}
            onChange={(v) => setFilter("partner", v)}
          />
        </FilterBar>
        {activeCount > 0 && (
          <span className="text-xs text-muted tabular-nums whitespace-nowrap">
            {rows.length} {pluralize(rows.length, "recipe", "recipes")}
          </span>
        )}
      </div>

      <div className="overflow-auto max-h-[calc(100vh-290px)] rounded-lg border border-line">
        <table className="text-xs border-collapse" style={{ tableLayout: "fixed", width: "max-content" }}>
          <colgroup>
            <col style={{ width: 170 }} />
            {columns.map((col) => (
              <col key={col.key} style={{ width: 108 }} />
            ))}
            <col style={{ width: 76 }} />
          </colgroup>
          <thead>
            <tr className="border-b border-line">
              <th className="sticky left-0 top-0 z-30 bg-surface px-3 py-2 text-left font-semibold text-secondary whitespace-nowrap">
                Recipe
              </th>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className="sticky top-0 z-20 bg-surface px-2 py-2 text-left font-medium text-secondary leading-tight"
                >
                  {col.label}
                </th>
              ))}
              <th className="sticky right-0 top-0 z-30 bg-surface px-2 py-2 text-right font-semibold text-secondary leading-tight border-l border-line/40">
                Total (BBL)
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length + 2} className="px-4 py-8 text-center text-muted">
                  {search.q ? `No recipes match “${search.q}”.` : "No recipes match the current filters."}
                </td>
              </tr>
            )}
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
                  <td className="sticky left-0 z-10 bg-canvas px-3 py-1.5 font-medium text-strong whitespace-nowrap border-r border-line/40 overflow-hidden text-ellipsis">
                    {row.recipeName}
                  </td>
                  {columns.map((col) => (
                    <Cell key={col.key} cell={row.cells[col.key]} col={col} />
                  ))}
                  <td
                    className={`sticky right-0 z-10 bg-canvas px-2 py-1.5 text-right font-semibold tabular-nums border-l border-line/40 ${
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
              <td className="sticky left-0 z-30 bg-surface px-3 py-2 text-left font-semibold text-secondary whitespace-nowrap border-r border-line/40">
                Total (BBL)
              </td>
              {columns.map((col) => (
                <td key={col.key} className="px-2 py-2 text-left font-semibold text-body tabular-nums">
                  {fmtBbl(columnTotals[col.key] ?? 0)}
                </td>
              ))}
              <td className="sticky right-0 z-30 bg-surface px-2 py-2 text-right font-bold text-accent-emphasis tabular-nums border-l border-line/40">
                {fmtBbl(grandTotalBbl)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
