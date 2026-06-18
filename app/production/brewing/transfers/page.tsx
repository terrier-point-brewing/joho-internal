"use client";

import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import SubNav from "@/app/components/SubNav";
import { PRODUCTION_NAV, BREWING_NAV } from "@/app/production/nav-config";
import { fmtBbl2 } from "@/lib/utils/formatting";
import { fetchJson } from "@/app/production/hooks/queries";

type TransferType = "transfer" | "kegging" | "canning" | "conversion" | "export";

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
  batch: { id: string; beer_name: string; batch_number: string | null } | null;
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
};

const TYPE_COLOR: Record<TransferType, string> = {
  transfer:   "bg-zinc-700/60 text-zinc-300 border-zinc-600",
  kegging:    "bg-emerald-900/50 text-emerald-300 border-emerald-700",
  canning:    "bg-cyan-900/50 text-cyan-300 border-cyan-700",
  conversion: "bg-amber-900/50 text-amber-300 border-amber-700",
  export:     "bg-purple-900/50 text-purple-300 border-purple-700",
};

function TypeBadge({ type }: { type: TransferType }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded border font-medium ${TYPE_COLOR[type] ?? TYPE_COLOR.transfer}`}>
      {TYPE_LABELS[type] ?? type}
    </span>
  );
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
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={PRODUCTION_NAV} mobile sticky />
      <SubNav entries={BREWING_NAV} sticky />

      <div className="mt-4 space-y-4">
        <div className="flex flex-wrap gap-2 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-zinc-500">From date</label>
            <input type="date" className="inp" value={filters.from}
              onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-zinc-500">To date</label>
            <input type="date" className="inp" value={filters.to}
              onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-zinc-500">Type</label>
            <select className="inp" value={filters.type}
              onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value }))}>
              <option value="">All types</option>
              {(Object.keys(TYPE_LABELS) as TransferType[]).map((t) => (
                <option key={t} value={t}>{TYPE_LABELS[t]}</option>
              ))}
            </select>
          </div>
          <button onClick={apply}
            className="px-3 py-1.5 text-sm rounded border border-amber-600 bg-amber-900/30 text-amber-300 hover:bg-amber-900/50 transition-colors">
            Apply
          </button>
          {(applied.from || applied.to || applied.type || applied.batch_id) && (
            <button onClick={clear}
              className="px-3 py-1.5 text-sm rounded border border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors">
              Clear
            </button>
          )}
          <span className="ml-auto text-xs text-zinc-500 self-end">
            {isLoading ? "Loading…" : `${rows.length} record${rows.length !== 1 ? "s" : ""}`}
          </span>
        </div>

        {isError && (
          <p className="text-red-400 text-sm">Failed to load transfer log.</p>
        )}

        <div className="overflow-x-auto rounded border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-left">
                <th className="px-3 py-2 text-xs text-zinc-500 font-medium whitespace-nowrap">Date / Time</th>
                <th className="px-3 py-2 text-xs text-zinc-500 font-medium">Type</th>
                <th className="px-3 py-2 text-xs text-zinc-500 font-medium">Batch</th>
                <th className="px-3 py-2 text-xs text-zinc-500 font-medium">From</th>
                <th className="px-3 py-2 text-xs text-zinc-500 font-medium">To</th>
                <th className="px-3 py-2 text-xs text-zinc-500 font-medium text-right">Volume</th>
                <th className="px-3 py-2 text-xs text-zinc-500 font-medium text-right">Shrinkage</th>
                <th className="px-3 py-2 text-xs text-zinc-500 font-medium">Actor</th>
                <th className="px-3 py-2 text-xs text-zinc-500 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-zinc-600 text-sm">
                    No transfers found.
                  </td>
                </tr>
              )}
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-zinc-800/60 hover:bg-zinc-800/30 transition-colors">
                  <td className="px-3 py-2 text-zinc-400 whitespace-nowrap font-mono text-xs">
                    {fmtDateTime(row.transferred_at)}
                  </td>
                  <td className="px-3 py-2">
                    <TypeBadge type={row.transfer_type} />
                  </td>
                  <td className="px-3 py-2">
                    <p className="text-zinc-100 font-medium leading-tight">{row.batch?.beer_name ?? "—"}</p>
                    {row.batch?.batch_number && (
                      <p className="text-zinc-500 font-mono text-xs">{row.batch.batch_number}</p>
                    )}
                  </td>
                  <td className="px-3 py-2 text-zinc-300 whitespace-nowrap">
                    {row.from_tank?.name ?? <span className="text-zinc-600">—</span>}
                    {row.from_tank?.type && (
                      <span className="text-zinc-600 text-xs ml-1">({row.from_tank.type})</span>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {row.to_batch_id ? (
                      <span className="text-amber-300">
                        {row.to_batch?.beer_name ?? "child batch"}
                        {row.to_batch?.batch_number && (
                          <span className="text-zinc-500 font-mono text-xs ml-1">{row.to_batch.batch_number}</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-zinc-300">
                        {row.to_tank?.name ?? <span className="text-zinc-600">—</span>}
                        {row.to_tank?.type && (
                          <span className="text-zinc-600 text-xs ml-1">({row.to_tank.type})</span>
                        )}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-zinc-200 font-mono tabular-nums whitespace-nowrap">
                    {fmtBbl2(row.volume_bbl)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums whitespace-nowrap">
                    {row.shrinkage_bbl > 0
                      ? <span className="text-red-400">{fmtBbl2(row.shrinkage_bbl)}</span>
                      : <span className="text-zinc-700">—</span>}
                  </td>
                  <td className="px-3 py-2 text-zinc-400 text-xs whitespace-nowrap">
                    {row.created_by_profile?.email ?? <span className="text-zinc-600">—</span>}
                  </td>
                  <td className="px-3 py-2 text-zinc-500 text-xs max-w-48 truncate">
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
