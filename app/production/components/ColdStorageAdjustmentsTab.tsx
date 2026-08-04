"use client";

import { EM_DASH } from "@/lib/format";
import { useColdStorageAdjustmentsQuery, type ColdStorageAdjustment } from "../hooks/queries";
import { useTableControls } from "@/app/components/ui/useTableControls";
import SearchInput from "@/app/components/ui/SearchInput";
import FilterChips from "@/app/components/ui/FilterChips";
import FilterBar from "@/app/components/ui/FilterBar";
import SortableTh from "@/app/components/ui/SortableTh";
import type { ControlsConfig } from "@/lib/table/types";

// Export > Adjustments — the cold_storage_transforms journal.
//
// Every internal reformatting of finished goods sitting in cold storage, of both
// kinds: manual keg transforms (a human cracked a 1/2 keg into sixtels) and
// automatic pack breaks (the taproom sold a single, so applyBreakDown cracked a
// sealed case). The pack breaks have been written since July with nothing
// reading them; this is their first read surface.
//
// This is also the ONLY place transform shrinkage is visible anywhere in the
// app. A transform happens after a batch is packaged out and closed, so the
// batch volume ledger deliberately never sees it — the same way shipping and
// taproom pours don't write back to it either.

const KIND_LABELS: Record<ColdStorageAdjustment["kind"], string> = {
  keg_transform: "Keg Transform",
  pack_break: "Pack Break",
};

const KIND_COLORS: Record<ColdStorageAdjustment["kind"], string> = {
  keg_transform: "bg-accent-muted/40 text-accent-soft border-accent-border",
  pack_break: "bg-info-surface/40 text-info border-info-border",
};

const KIND_OPTIONS = [
  { value: "keg_transform", label: "Keg Transform" },
  { value: "pack_break", label: "Pack Break" },
];

const ADJUSTMENT_CONTROLS: ControlsConfig<ColdStorageAdjustment> = {
  search: [{ param: "q", accessor: (r) => `${r.beer_name ?? ""} ${r.batch_number ?? ""} ${r.from_variation_name ?? ""} ${r.to_variation_name ?? ""} ${r.note ?? ""}` }],
  filters: [{ param: "kind", accessor: (r) => r.kind }],
  sort: {
    columns: [
      { key: "date", accessor: (r) => r.occurred_at },
      { key: "shrinkage", accessor: (r) => r.shrinkage_fl_oz },
    ],
    default: { key: "date", dir: "desc" },
  },
};

const fmtUnits = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Who recorded it. A manual transform has an actor; an automatic break has a
 *  trace key back to the triggering sale and no human behind it. */
function actorLabel(r: ColdStorageAdjustment): string {
  if (r.created_by_email) return r.created_by_email.split("@")[0];
  if (r.source_ref) return "Automatic";
  return EM_DASH;
}

export default function ColdStorageAdjustmentsTab() {
  // isPending, NOT isLoading. isLoading is `isPending && isFetching`, so it goes
  // FALSE while React Query has a retry paused (fetchStatus: 'paused') — and a
  // load that hasn't landed would fall straight through to the empty state,
  // reporting "nothing recorded" for what is actually a failed fetch. isPending
  // stays true until there's real data, which is the question being asked here.
  const { data: adjustments = [], isPending, error } = useColdStorageAdjustmentsQuery();

  const { rows: filtered, search, filters, sort, setSearch, setFilter, toggleSort, reset, activeCount } =
    useTableControls(adjustments, ADJUSTMENT_CONTROLS, { prefix: "csadj_" });

  // Only counts what's on screen, so it answers the question the filters ask —
  // e.g. "how much did we lose to keg transforms this month".
  const totalShrinkageBbl = filtered.reduce((s, r) => s + r.shrinkage_bbl, 0);

  return (
    <div>
      <p className="text-xs text-muted mb-4 max-w-3xl">
        Repackaging of stock already in cold storage — breaking a half keg down into sixtels, or
        cracking a sealed case for a taproom single. Nothing enters or leaves the cold room, so these
        are neither shipments nor production. Kegs lose a little volume in the process; that loss is
        recorded here and nowhere else.
      </p>

      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <FilterBar activeCount={activeCount} onClear={reset}>
          <SearchInput
            value={search.q ?? ""}
            onChange={(v) => setSearch("q", v)}
            placeholder="Search beer, batch, packaging…"
          />
          <FilterChips
            label="Type"
            options={KIND_OPTIONS}
            value={filters.kind ?? []}
            onChange={(v) => setFilter("kind", v)}
          />
        </FilterBar>

        <div className="ml-auto flex items-center gap-3 shrink-0">
          {totalShrinkageBbl > 0.0001 && (
            <span className="text-xs text-accent-emphasis/80 tabular-nums">
              {totalShrinkageBbl.toFixed(2)} bbl shrinkage
            </span>
          )}
          <span className="text-xs text-faint">{filtered.length} records</span>
        </div>
      </div>

      {error ? (
        <p className="text-danger text-sm">{error instanceof Error ? error.message : "Could not load adjustments."}</p>
      ) : isPending ? (
        <p className="text-faint text-sm">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-faint text-sm">No cold storage adjustments recorded.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface/50 text-left">
                <SortableTh label="Date" sortKey="date" sort={sort} onSort={toggleSort} />
                <th className="px-3 py-2.5 text-xs font-medium text-muted whitespace-nowrap">Type</th>
                <th className="px-3 py-2.5 text-xs font-medium text-muted">Beer</th>
                <th className="px-3 py-2.5 text-xs font-medium text-muted whitespace-nowrap">Batch</th>
                <th className="px-3 py-2.5 text-xs font-medium text-muted">From</th>
                <th className="px-3 py-2.5 text-xs font-medium text-muted">To</th>
                <SortableTh label="Shrinkage" sortKey="shrinkage" sort={sort} onSort={toggleSort} align="right" />
                <th className="px-3 py-2.5 text-xs font-medium text-muted">Note</th>
                <th className="px-3 py-2.5 text-xs font-medium text-muted whitespace-nowrap">By</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr key={r.id} className={`border-b border-line/60 last:border-0 ${i % 2 !== 0 ? "bg-surface/30" : ""}`}>
                  <td className="px-3 py-2 text-muted text-xs whitespace-nowrap">{fmtDate(r.occurred_at)}</td>
                  <td className="px-3 py-2">
                    <span className={`text-xs px-1.5 py-px rounded border whitespace-nowrap ${KIND_COLORS[r.kind]}`}>
                      {KIND_LABELS[r.kind]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-body font-medium max-w-[180px] truncate">{r.beer_name ?? EM_DASH}</td>
                  <td className="px-3 py-2 text-faint text-xs font-mono whitespace-nowrap">{r.batch_number ?? EM_DASH}</td>
                  <td className="px-3 py-2 text-secondary text-xs whitespace-nowrap">
                    <span className="text-danger font-mono tabular-nums">{fmtUnits(r.from_units)}×</span>{" "}
                    {r.from_variation_name ?? EM_DASH}
                  </td>
                  <td className="px-3 py-2 text-secondary text-xs whitespace-nowrap">
                    <span className="text-success font-mono tabular-nums">{fmtUnits(r.to_units)}×</span>{" "}
                    {r.to_variation_name ?? EM_DASH}
                  </td>
                  {/* A pack break conserves exactly, so a literal 0.00 bbl would be
                      noise on every automatic row — show a dash instead. */}
                  <td className="px-3 py-2 text-right tabular-nums text-xs font-mono whitespace-nowrap">
                    {r.shrinkage_fl_oz > 0.0001 ? (
                      <span className="text-accent-emphasis/90">{r.shrinkage_bbl.toFixed(3)} bbl</span>
                    ) : (
                      <span className="text-faint">{EM_DASH}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted text-xs max-w-[160px] truncate">{r.note ?? EM_DASH}</td>
                  <td className="px-3 py-2 text-faint text-xs whitespace-nowrap">{actorLabel(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
