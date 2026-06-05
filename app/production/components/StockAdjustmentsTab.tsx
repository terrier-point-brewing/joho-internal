"use client";

import { useState, useEffect, useCallback } from "react";
import {
  StockAdjustment, PackagingStockAdjustment, BrewInventoryAdjustment,
  Ingredient, PackagingItem, BatchTransfer, BrewBatch, AdjustmentType, PackagingAdjustmentType, BrewAdjustmentType,
} from "../types";

type Source = "all" | "ingredients" | "packaging" | "brew";
type SortDir = "desc" | "asc";

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
const BREW_TYPE_LABELS: Record<BrewAdjustmentType, string> = {
  sold:            "Sold",
  distributed:     "Distributed",
  waste:           "Waste / Loss",
  inventory_count: "Inventory Count",
};

type Row = {
  id: string;
  source: "ingredients" | "packaging" | "brew";
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
  if (v == null) return "—";
  return (v >= 0 ? "+" : "") + `$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function qtyColor(qty: number) {
  return qty >= 0 ? "text-green-400" : "text-red-400";
}
function valColor(v: number | null) {
  if (v == null) return "text-zinc-600";
  return v >= 0 ? "text-green-400" : "text-red-400";
}

const SOURCE_COLORS: Record<Row["source"], string> = {
  ingredients: "bg-amber-900/40 text-amber-300 border-amber-700",
  packaging:   "bg-blue-900/40 text-blue-300 border-blue-700",
  brew:        "bg-emerald-900/40 text-emerald-300 border-emerald-700",
};

function buildRows(
  ingAdjs: StockAdjustment[],
  pkgAdjs: PackagingStockAdjustment[],
  brewAdjs: BrewInventoryAdjustment[],
  ingredients: Ingredient[],
  packaging: PackagingItem[],
  transfers: BatchTransfer[],
  batches: BrewBatch[],
): Row[] {
  const ingMap = Object.fromEntries(ingredients.map((i) => [i.id, i]));
  const pkgMap = Object.fromEntries(packaging.map((p) => [p.id, p]));
  const trMap  = Object.fromEntries(transfers.map((t) => [t.id, t]));

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
      costPerUnit: a.cost_per_unit,
      valueChange: a.total_value_change,
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
      costPerUnit: a.cost_per_unit,
      valueChange: a.total_value_change,
      note: a.note,
      batch: null,
      createdAt: a.created_at,
    };
  });

  const brewRows: Row[] = brewAdjs.map((a) => {
    const tr = trMap[a.batch_transfer_id];
    const unit = tr?.transfer_type === "kegging" ? "keg" : "can";
    const batchName = tr ? batches.find((b) => b.id === tr.batch_id)?.beer_name ?? "" : "";
    return {
      id: a.id,
      source: "brew",
      sourceLabel: "Brew",
      itemName: tr ? `${unit.charAt(0).toUpperCase() + unit.slice(1)}s — ${batchName}`.trim() : "Brew lot",
      type: a.type,
      typeLabel: BREW_TYPE_LABELS[a.type] ?? a.type,
      quantity: a.quantity,
      unitLabel: `${unit}s`,
      costPerUnit: null,
      valueChange: null,
      note: a.note,
      batch: null,
      createdAt: a.created_at,
    };
  });

  return [...ingRows, ...pkgRows, ...brewRows];
}

export default function StockAdjustmentsTab({
  ingAdjustments,
  ingredients,
  packaging,
  transfers,
  batches,
}: {
  ingAdjustments: StockAdjustment[];
  ingredients: Ingredient[];
  packaging: PackagingItem[];
  transfers: BatchTransfer[];
  batches: BrewBatch[];
}) {
  const [pkgAdjs, setPkgAdjs]   = useState<PackagingStockAdjustment[]>([]);
  const [brewAdjs, setBrewAdjs] = useState<BrewInventoryAdjustment[]>([]);
  const [loading, setLoading]   = useState(true);

  const [source, setSource]         = useState<Source>("all");
  const [search, setSearch]         = useState("");
  const [sortDir, setSortDir]       = useState<SortDir>("desc");
  const [groupByDate, setGroupByDate] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [pkgRes, brewRes] = await Promise.all([
      fetch("/api/production/packaging-adjustments"),
      fetch("/api/production/brew-adjustments"),
    ]);
    if (pkgRes.ok)  setPkgAdjs(await pkgRes.json());
    if (brewRes.ok) setBrewAdjs(await brewRes.json());
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const allRows = buildRows(ingAdjustments, pkgAdjs, brewAdjs, ingredients, packaging, transfers, batches);

  const filtered = allRows
    .filter((r) => source === "all" || r.source === source)
    .filter((r) => !search || r.itemName.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      const diff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return sortDir === "desc" ? -diff : diff;
    });

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
        return Array.from(map.entries()).map(([k, rows]) => ({ label: fmtDay(rows[0].createdAt), rows }));
      })()
    : [{ label: "", rows: filtered }];

  const thead = (
    <thead>
      <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
        <th className="px-3 py-2.5 text-xs font-medium text-zinc-500 whitespace-nowrap">Date</th>
        <th className="px-3 py-2.5 text-xs font-medium text-zinc-500 whitespace-nowrap">Source</th>
        <th className="px-3 py-2.5 text-xs font-medium text-zinc-500">Item</th>
        <th className="px-3 py-2.5 text-xs font-medium text-zinc-500">Type</th>
        <th className="px-3 py-2.5 text-xs font-medium text-zinc-500 text-right whitespace-nowrap">Change</th>
        <th className="px-3 py-2.5 text-xs font-medium text-zinc-500 text-right whitespace-nowrap">Unit Cost</th>
        <th className="px-3 py-2.5 text-xs font-medium text-zinc-500 text-right whitespace-nowrap">Value Δ</th>
        <th className="px-3 py-2.5 text-xs font-medium text-zinc-500 whitespace-nowrap">Note</th>
        <th className="px-3 py-2.5 text-xs font-medium text-zinc-500 whitespace-nowrap">Batch</th>
      </tr>
    </thead>
  );

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        {/* Source filter */}
        <div className="flex gap-1 flex-wrap">
          {(["all", "ingredients", "packaging", "brew"] as Source[]).map((s) => (
            <button
              key={s}
              onClick={() => setSource(s)}
              className={`text-xs px-2.5 py-1 rounded border transition-colors capitalize ${
                source === s
                  ? "border-zinc-500 text-zinc-200 bg-zinc-800"
                  : "border-zinc-700 text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {s === "all" ? "All" : s === "ingredients" ? "Ingredients" : s === "packaging" ? "Packaging" : "Brew (Kegs/Cans)"}
            </button>
          ))}
        </div>

        {/* Search */}
        <input
          className="inp w-48 text-sm"
          placeholder="Search item…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        {/* Sort */}
        <button
          onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
          className="text-xs px-2.5 py-1 rounded border border-zinc-700 text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          Date {sortDir === "desc" ? "↓ Newest" : "↑ Oldest"}
        </button>

        {/* Group */}
        <button
          onClick={() => setGroupByDate((v) => !v)}
          className={`text-xs px-2.5 py-1 rounded border transition-colors ${
            groupByDate ? "border-amber-600 bg-amber-900/30 text-amber-300" : "border-zinc-700 text-zinc-500 hover:text-zinc-300"
          }`}
        >
          Group by Day
        </button>

        <span className="ml-auto text-xs text-zinc-600">{filtered.length} records</span>
      </div>

      {loading ? (
        <p className="text-zinc-600 text-sm">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-zinc-600 text-sm">No adjustments found.</p>
      ) : (
        <div className="space-y-6">
          {groups.map((group, gi) => (
            <div key={gi}>
              {groupByDate && (
                <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2 px-1">{group.label}</h3>
              )}
              <div className="overflow-x-auto rounded-lg border border-zinc-800">
                <table className="w-full text-sm">
                  {thead}
                  <tbody>
                    {group.rows.map((r, i) => (
                      <tr key={r.id} className={`border-b border-zinc-800/60 last:border-0 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""}`}>
                        <td className="px-3 py-2 text-zinc-500 text-xs whitespace-nowrap">{fmtDate(r.createdAt)}</td>
                        <td className="px-3 py-2">
                          <span className={`text-xs px-1.5 py-px rounded border ${SOURCE_COLORS[r.source]}`}>{r.sourceLabel}</span>
                        </td>
                        <td className="px-3 py-2 text-zinc-300 font-medium max-w-[180px] truncate">{r.itemName}</td>
                        <td className="px-3 py-2 text-zinc-400 text-xs whitespace-nowrap">{r.typeLabel}</td>
                        <td className={`px-3 py-2 text-right tabular-nums text-xs font-mono whitespace-nowrap ${qtyColor(r.quantity)}`}>
                          {fmtQty(r.quantity)} {r.unitLabel}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-xs text-zinc-400 whitespace-nowrap">
                          {r.costPerUnit != null ? `$${Number(r.costPerUnit).toFixed(4)}` : "—"}
                        </td>
                        <td className={`px-3 py-2 text-right tabular-nums text-xs font-mono whitespace-nowrap ${valColor(r.valueChange)}`}>
                          {r.valueChange != null ? fmtValue(r.valueChange) : "—"}
                        </td>
                        <td className="px-3 py-2 text-zinc-500 text-xs max-w-[140px] truncate">{r.note ?? "—"}</td>
                        <td className="px-3 py-2 text-zinc-600 text-xs font-mono whitespace-nowrap">{r.batch ?? "—"}</td>
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
