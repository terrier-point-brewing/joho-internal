"use client";

import { useState } from "react";
import { formatCurrency, EM_DASH } from "@/lib/format";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import {
  StockAdjustment, PackagingStockAdjustment,
  AdjustmentType, PackagingAdjustmentType,
  Ingredient, PackagingItem,
} from "../types";
import {
  useAdjustmentsQuery, useIngredientsQuery, usePackagingQuery, fetchJson,
} from "../hooks/queries";
import { useTableControls } from "@/app/components/ui/useTableControls";
import SearchInput from "@/app/components/ui/SearchInput";
import FilterChips from "@/app/components/ui/FilterChips";
import FilterBar from "@/app/components/ui/FilterBar";
import ToggleChip from "@/app/components/ui/ToggleChip";
import SortableTh from "@/app/components/ui/SortableTh";
import type { ControlsConfig } from "@/lib/table/types";

const ING_TYPE_LABELS: Record<AdjustmentType, string> = {
  received:        "Received",
  used:            "Used",
  waste:           "Waste / Loss",
  inventory_count: "Inventory Count",
  batch_use:       "Batch Use",
};
const PKG_TYPE_LABELS: Record<PackagingAdjustmentType, string> = {
  received:        "Received",
  used:            "Used",
  waste:           "Waste / Loss",
  inventory_count: "Inventory Count",
};
type Row = {
  id: string;
  source: "ingredients" | "packaging";
  sourceLabel: string;
  itemName: string;
  type: string;
  typeLabel: string;
  quantity: number;
  unitLabel: string;
  costPerUnit: number | null;
  valueChange: number | null;
  note: string | null;
  batch: string | null;
  createdAt: string;
};

function fmtQty(qty: number) {
  const abs = Math.abs(qty).toLocaleString(undefined, { maximumFractionDigits: 3 });
  return qty >= 0 ? `+${abs}` : `-${abs}`;
}

function fmtValue(v: number | null | undefined) {
  if (v == null) return EM_DASH;
  return (v >= 0 ? "+" : "") + formatCurrency(Math.abs(v));
}

function qtyColor(qty: number) {
  return qty >= 0 ? "text-success" : "text-danger";
}
function valColor(v: number | null) {
  if (v == null) return "text-faint";
  return v >= 0 ? "text-success" : "text-danger";
}

const SOURCE_COLORS: Record<Row["source"], string> = {
  ingredients: "bg-accent-muted/40 text-accent-soft border-accent-border",
  packaging:   "bg-info-surface/40 text-info border-info-border",
};

const ADJUSTMENT_CONTROLS: ControlsConfig<Row> = {
  search: [{ param: "q", accessor: (r) => r.itemName }],
  filters: [{ param: "source", accessor: (r) => r.source }],
  sort: {
    columns: [{ key: "date", accessor: (r) => r.createdAt }],
    default: { key: "date", dir: "desc" },
  },
};

const SOURCE_OPTIONS = [
  { value: "ingredients", label: "Ingredients" },
  { value: "packaging", label: "Packaging" },
];

function buildRows(
  ingAdjs: StockAdjustment[],
  pkgAdjs: PackagingStockAdjustment[],
  ingredients: Ingredient[],
  packaging: PackagingItem[],
): Row[] {
  const ingMap = Object.fromEntries(ingredients.map((i) => [i.id, i]));
  const pkgMap = Object.fromEntries(packaging.map((p) => [p.id, p]));

  const ingRows: Row[] = ingAdjs.map((a) => {
    const ing = ingMap[a.ingredient_id];
    return {
      id: a.id,
      source: "ingredients",
      sourceLabel: "Ingredient",
      itemName: a.ingredients?.name ?? ing?.name ?? "—",
      type: a.type,
      typeLabel: ING_TYPE_LABELS[a.type] ?? a.type,
      quantity: a.quantity,
      unitLabel: a.ingredients?.unit ?? ing?.unit ?? "",
      costPerUnit: a.cost_per_unit_usd,
      valueChange: a.total_value_change_usd,
      note: a.note,
      batch: a.brew_batches ? `#${a.brew_batches.batch_number ?? ""} ${a.brew_batches.beer_name}`.trim() : null,
      createdAt: a.created_at,
    };
  });

  const pkgRows: Row[] = pkgAdjs.map((a) => {
    const pkg = pkgMap[a.packaging_item_id];
    return {
      id: a.id,
      source: "packaging",
      sourceLabel: "Packaging",
      itemName: a.packaging_items?.name ?? pkg?.name ?? "—",
      type: a.type,
      typeLabel: PKG_TYPE_LABELS[a.type] ?? a.type,
      quantity: a.quantity,
      unitLabel: "units",
      costPerUnit: a.cost_per_unit_usd,
      valueChange: a.total_value_change_usd,
      note: a.note,
      batch: null,
      createdAt: a.created_at,
    };
  });

  return [...ingRows, ...pkgRows];
}

export default function StockAdjustmentsTab() {
  const { data: ingAdjustments = [], isPending: ingPending, error: ingError } = useAdjustmentsQuery();
  const { data: ingredients = [] } = useIngredientsQuery();
  const { data: packaging = [] } = usePackagingQuery();
  const { data: pkgAdjs = [], isPending: pkgPending, error: pkgError } = useQuery({
    queryKey: queryKeys.production.packagingAdjustments(),
    queryFn: () => fetchJson<PackagingStockAdjustment[]>("/api/production/packaging-adjustments"),
  });
  // isPending, not isLoading: isLoading is `isPending && isFetching`, so a retry
  // React Query has paused reads as false while there is still no data — the
  // render would fall through to "No adjustments found" for a load that never
  // landed. Both adjustment feeds gate the table because the rows are their union.
  const loading = ingPending || pkgPending;
  const loadError = ingError ?? pkgError;

  const [groupByDate, setGroupByDate] = useState(false);

  const allRows = buildRows(ingAdjustments, pkgAdjs, ingredients, packaging);

  const { rows: filtered, search, filters, sort, setSearch, setFilter, toggleSort, reset, activeCount } =
    useTableControls(allRows, ADJUSTMENT_CONTROLS, { prefix: "adj_" });

  function fmtDate(iso: string) {
    return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function fmtDay(iso: string) {
    return new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  }

  // Group by calendar day if requested
  const groups: { label: string; rows: Row[] }[] = groupByDate
    ? (() => {
        const map = new Map<string, Row[]>();
        for (const r of filtered) {
          const key = new Date(r.createdAt).toDateString();
          if (!map.has(key)) map.set(key, []);
          map.get(key)!.push(r);
        }
        return Array.from(map.entries()).map(([, rows]) => ({ label: fmtDay(rows[0].createdAt), rows }));
      })()
    : [{ label: "", rows: filtered }];

  const thead = (
    <thead>
      <tr className="border-b border-line bg-surface/50 text-left">
        <SortableTh label="Date" sortKey="date" sort={sort} onSort={toggleSort} />
        <th className="px-3 py-2.5 text-xs font-medium text-muted whitespace-nowrap">Source</th>
        <th className="px-3 py-2.5 text-xs font-medium text-muted">Item</th>
        <th className="px-3 py-2.5 text-xs font-medium text-muted">Type</th>
        <th className="px-3 py-2.5 text-xs font-medium text-muted text-right whitespace-nowrap">Change</th>
        <th className="px-3 py-2.5 text-xs font-medium text-muted text-right whitespace-nowrap">Unit Cost</th>
        <th className="px-3 py-2.5 text-xs font-medium text-muted text-right whitespace-nowrap">Value Δ</th>
        <th className="px-3 py-2.5 text-xs font-medium text-muted whitespace-nowrap">Note</th>
        <th className="px-3 py-2.5 text-xs font-medium text-muted whitespace-nowrap">Batch</th>
      </tr>
    </thead>
  );

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <FilterBar activeCount={activeCount} onClear={reset}>
          <SearchInput
            value={search.q ?? ""}
            onChange={(v) => setSearch("q", v)}
            placeholder="Search items…"
          />
          <FilterChips
            label="Source"
            options={SOURCE_OPTIONS}
            value={filters.source ?? []}
            onChange={(v) => setFilter("source", v)}
          />
        </FilterBar>

        {/* View options + count, anchored right */}
        <div className="ml-auto flex items-center gap-3 shrink-0">
          <ToggleChip active={groupByDate} onClick={() => setGroupByDate((v) => !v)}>
            Group by Day
          </ToggleChip>
          <span className="text-xs text-faint">{filtered.length} records</span>
        </div>
      </div>

      {loading ? (
        <p className="text-faint text-sm">Loading…</p>
      ) : loadError ? (
        <p className="text-sm text-danger">
          Could not load adjustments: {loadError instanceof Error ? loadError.message : "unknown error"}
        </p>
      ) : filtered.length === 0 ? (
        <p className="text-faint text-sm">No adjustments found.</p>
      ) : (
        <div className="space-y-6">
          {groups.map((group, gi) => (
            <div key={gi}>
              {groupByDate && (
                <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2 px-1">{group.label}</h3>
              )}
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-sm">
                  {thead}
                  <tbody>
                    {group.rows.map((r, i) => (
                      <tr key={r.id} className={`border-b border-line/60 last:border-0 ${i % 2 !== 0 ? "bg-surface/30" : ""}`}>
                        <td className="px-3 py-2 text-muted text-xs whitespace-nowrap">{fmtDate(r.createdAt)}</td>
                        <td className="px-3 py-2">
                          <span className={`text-xs px-1.5 py-px rounded border ${SOURCE_COLORS[r.source]}`}>{r.sourceLabel}</span>
                        </td>
                        <td className="px-3 py-2 text-body font-medium max-w-[180px] truncate">{r.itemName}</td>
                        <td className="px-3 py-2 text-secondary text-xs whitespace-nowrap">{r.typeLabel}</td>
                        <td className={`px-3 py-2 text-right tabular-nums text-xs font-mono whitespace-nowrap ${qtyColor(r.quantity)}`}>
                          {fmtQty(r.quantity)} {r.unitLabel}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-xs text-secondary whitespace-nowrap">
                          {r.costPerUnit != null ? `$${Number(r.costPerUnit).toFixed(4)}` : "—"}
                        </td>
                        <td className={`px-3 py-2 text-right tabular-nums text-xs font-mono whitespace-nowrap ${valColor(r.valueChange)}`}>
                          {r.valueChange != null ? fmtValue(r.valueChange) : "—"}
                        </td>
                        <td className="px-3 py-2 text-muted text-xs max-w-[140px] truncate">{r.note ?? "—"}</td>
                        <td className="px-3 py-2 text-faint text-xs font-mono whitespace-nowrap">{r.batch ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
