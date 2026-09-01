"use client";

import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import SubNav from "@/app/components/SubNav";
import { PRODUCTION_NAV, BREWING_NAV } from "@/app/production/nav-config";
import { fmtBbl2 } from "@/lib/utils/formatting";
import { fetchJson } from "@/app/production/hooks/queries";
import { TRANSFER_TYPE_BADGE } from "@/app/production/lib/categoryColors";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
import FilterBar from "@/app/components/ui/FilterBar";
import FilterSelect from "@/app/components/ui/FilterSelect";

type TransferType = "transfer" | "kegging" | "canning" | "conversion" | "export" | "brewing";

interface TransferLogRow {
  id: string;
  batch_id: string;
  from_tank_id: string | null;
  to_tank_id: string | null;
  volume_bbl: number;
  shrinkage_bbl: number;
  transfer_type: TransferType;
  notes: string | null;
  transferred_at: string;
  to_batch_id: string | null;
  quantity: number | null;
  batch: { id: string; beer_name: string; batch_number: string | null } | null;
  packaging_variations: { id: string; name: string } | null;
  packaged_as: { id: string; beer_name: string } | null;
  from_tank: { id: string; name: string; type: string } | null;
  to_tank:   { id: string; name: string; type: string } | null;
  to_batch:  { id: string; beer_name: string; batch_number: string | null } | null;
  created_by_profile: { email: string } | null;
}

const TYPE_LABELS: Record<TransferType, string> = {
  transfer:   "Transfer",
  kegging:    "Kegging",
  canning:    "Canning",
  conversion: "Conversion",
  export:     "Export",
  brewing:    "Brewing",
};

function TypeBadge({ type }: { type: TransferType }) {
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded border font-medium ${
        TRANSFER_TYPE_BADGE[type] ?? TRANSFER_TYPE_BADGE.transfer
      }`}
    >
      {TYPE_LABELS[type] ?? type}
    </span>
  );
}

// An in-keg conversion leaves no second batch to point at, so the beer it
// produced only shows up here — without it, a run that kegged Pace Yourself
// Pilsner as Orange Pilsner reads as an ordinary kegging of the base beer.
function outputLabel(row: TransferLogRow) {
  if (!row.quantity || !row.packaging_variations?.name) return null;
  return `${row.quantity}× ${row.packaging_variations.name}${
    row.packaged_as ? ` — ${row.packaged_as.beer_name}` : ""
  }`;
}

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

function buildUrl(filters: { batch_id: string; from: string; to: string; type: string }) {
  const p = new URLSearchParams();
  if (filters.batch_id) p.set("batch_id", filters.batch_id);
  if (filters.from)     p.set("from",     filters.from);
  if (filters.to)       p.set("to",       filters.to);
  if (filters.type)     p.set("type",     filters.type);
  return `/api/production/transfer-log?${p.toString()}`;
}

export default function TransferLogPage() {
  const [filters, setFilters] = useState({ batch_id: "", from: "", to: "", type: "" });
  const [applied, setApplied] = useState(filters);

  const { data: rows = [], isLoading, isError } = useQuery({
    queryKey: ["transfer-log", applied],
    queryFn: () => fetchJson<TransferLogRow[]>(buildUrl(applied)),
  });

  function apply() { setApplied({ ...filters }); }
  function clear()  { const empty = { batch_id: "", from: "", to: "", type: "" }; setFilters(empty); setApplied(empty); }

  return (
    <main className="px-4 sm:px-6">
      <StickyHeader>
        <SubNav entries={PRODUCTION_NAV} mobile />
        <PageHeader title="Brewing" description="Batch tracking, fermentation monitoring, and equipment scheduling" />
        <SubNav entries={BREWING_NAV} />
      </StickyHeader>

      <div className="mt-4 pb-4 sm:pb-8 space-y-4">
        <FilterBar
          activeCount={[applied.from, applied.to, applied.type, applied.batch_id].filter(Boolean).length}
          onClear={clear}
        >
          <label className="inline-flex items-center gap-1.5 text-xs text-muted">
            From
            <input type="date" className="inp-sm w-auto" value={filters.from}
              onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
          </label>
          <label className="inline-flex items-center gap-1.5 text-xs text-muted">
            To
            <input type="date" className="inp-sm w-auto" value={filters.to}
              onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
          </label>
          <FilterSelect
            label="Type"
            options={(Object.keys(TYPE_LABELS) as TransferType[]).map((t) => ({ value: t, label: TYPE_LABELS[t] }))}
            value={filters.type ? [filters.type] : []}
            onChange={(v) => setFilters((f) => ({ ...f, type: v[0] ?? "" }))}
            allLabel="All types"
          />
          <button onClick={apply} className="btn-primary">Apply</button>
        </FilterBar>
        <p className="text-xs text-muted">
          {isLoading ? "Loading…" : `${rows.length} record${rows.length !== 1 ? "s" : ""}`}
        </p>

        {isError && (
          <p className="text-danger text-sm">Failed to load transfer log.</p>
        )}

        <div className="overflow-x-auto rounded border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="px-3 py-2 text-xs text-muted font-medium whitespace-nowrap">Date / Time</th>
                <th className="px-3 py-2 text-xs text-muted font-medium">Type</th>
                <th className="px-3 py-2 text-xs text-muted font-medium">Batch</th>
                <th className="px-3 py-2 text-xs text-muted font-medium">From</th>
                <th className="px-3 py-2 text-xs text-muted font-medium">To</th>
                <th className="px-3 py-2 text-xs text-muted font-medium text-right">Volume</th>
                <th className="px-3 py-2 text-xs text-muted font-medium text-right">Shrinkage</th>
                <th className="px-3 py-2 text-xs text-muted font-medium">Output</th>
                <th className="px-3 py-2 text-xs text-muted font-medium">Actor</th>
                <th className="px-3 py-2 text-xs text-muted font-medium">Notes</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={10} className="px-3 py-6 text-center text-faint text-sm">
                    No transfers found.
                  </td>
                </tr>
              )}
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-line/60 hover:bg-surface-mid/30 transition-colors">
                  <td className="px-3 py-2 text-secondary whitespace-nowrap font-mono text-xs">
                    {fmtDateTime(row.transferred_at)}
                  </td>
                  <td className="px-3 py-2">
                    <TypeBadge type={row.transfer_type} />
                  </td>
                  <td className="px-3 py-2">
                    <p className="text-primary font-medium leading-tight">{row.batch?.beer_name ?? "—"}</p>
                    {row.batch?.batch_number && (
                      <p className="text-muted font-mono text-xs">{row.batch.batch_number}</p>
                    )}
                  </td>
                  <td className="px-3 py-2 text-body whitespace-nowrap">
                    {row.from_tank?.name ?? <span className="text-faint">—</span>}
                    {row.from_tank?.type && (
                      <span className="text-faint text-xs ml-1">({row.from_tank.type})</span>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {row.to_batch_id ? (
                      <span className="text-accent-soft">
                        {row.to_batch?.beer_name ?? "child batch"}
                        {row.to_batch?.batch_number && (
                          <span className="text-muted font-mono text-xs ml-1">{row.to_batch.batch_number}</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-body">
                        {row.to_tank?.name ?? <span className="text-faint">—</span>}
                        {row.to_tank?.type && (
                          <span className="text-faint text-xs ml-1">({row.to_tank.type})</span>
                        )}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-strong font-mono tabular-nums whitespace-nowrap">
                    {fmtBbl2(row.volume_bbl)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums whitespace-nowrap">
                    {row.shrinkage_bbl > 0
                      ? <span className="text-danger">{fmtBbl2(row.shrinkage_bbl)}</span>
                      : <span className="text-disabled">—</span>}
                  </td>
                  <td className="px-3 py-2 text-secondary text-xs whitespace-nowrap">
                    {outputLabel(row) ?? <span className="text-disabled">—</span>}
                  </td>
                  <td className="px-3 py-2 text-secondary text-xs whitespace-nowrap">
                    {row.created_by_profile?.email ?? <span className="text-faint">—</span>}
                  </td>
                  <td className="px-3 py-2 text-muted text-xs max-w-48 truncate">
                    {row.notes ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
