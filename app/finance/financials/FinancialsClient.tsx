"use client";

// Consolidated Financials page shell (statement-primary MoM view, spec §3).
// Composition only: fetches GET /api/finance/financials via react-query and
// wires the statement selector / KPI health strip / measure toggle / year
// picker around Task 9's FinancialsTable. Tree-building (buildTree) and all
// KPI/amount math live in lib/finance/financials -- nothing here recomputes
// them.
//
// `initialStatement`/`initialYear` arrive from page.tsx rather than being
// derived here, and that is load-bearing rather than tidiness: page.tsx
// prefetches exactly one query key on the server, and this component has to ask
// for that same key on its first render or the prefetch is dead weight and the
// browser pays for the fetch anyway. Deriving the year from the browser clock
// (as this did) could disagree with the server's on New Year's Eve; deriving the
// statement from useSearchParams() meant the value only existed after hydration.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import { formatCurrencyCents, formatPercent, EM_DASH } from "@/lib/format";
import type { FinancialsResponse, FinancialsRow, Measure, StatementKind } from "@/lib/finance/financials/types";
import type { StatementSection } from "@/lib/finance/accountSections";
import PageHeader from "@/app/components/PageHeader";
import Banner from "@/app/components/ui/Banner";
import Card from "@/app/components/ui/Card";
import TabBar, { type TabDef } from "@/app/components/TabBar";
import { useTableControls } from "@/app/components/ui/useTableControls";
import SearchInput from "@/app/components/ui/SearchInput";
import FilterChips from "@/app/components/ui/FilterChips";
import FilterSelect from "@/app/components/ui/FilterSelect";
import FilterBar from "@/app/components/ui/FilterBar";
import FinanceNav from "../FinanceNav";
import CloseTasksBanner from "../CloseTasksBanner";
import FinancialsTable from "./FinancialsTable";
import DataQualityPanel from "./DataQualityPanel";
import { buildTree } from "./buildTree";
import { buildFinancialsControls, retainAncestors, CHANNEL_OPTIONS, QUALITY_OPTIONS, SECTION_LABEL } from "./controls";
import { totalModeFor } from "@/lib/finance/financials/statementTotal";

// Stable empty-array reference so useTableControls/useMemo deps don't churn
// on every render while `data` is still loading (a fresh `[]` literal would
// be a new reference each time).
const EMPTY_ROWS: FinancialsRow[] = [];

const STATEMENT_TABS: TabDef<StatementKind>[] = [
  { key: "pl",            label: "P&L" },
  { key: "balance_sheet", label: "Balance Sheet" },
  { key: "cash_flow",     label: "Cash Flow" },
];

// Measure is a required, always-exactly-one-selected view mode (never "none"),
// unlike every other FilterBar control (Channel/Section/Quality/GL #), which
// are optional and support an implicit "All"/off state -- so it's rendered
// with a small dedicated exclusive-chip group (MeasureChips below) instead of
// the shared FilterChips/FilterSelect primitives, which always render an
// "All" option that has no valid meaning here.
const MEASURE_OPTIONS: { value: Measure; label: string }[] = [
  { value: "amount",          label: "$" },
  { value: "bbl",             label: "BBL" },
  { value: "amount_per_bbl", label: "$/BBL" },
];

// ── KPI health strip ────────────────────────────────────────────────────────

/** A single stat tile. `null` renders a muted em-dash rather than a fake `$0`. */
function KpiTile({ label, cents, pct, percentDenominated, subLabel }: {
  label: string;
  cents?: number | null;
  pct?: number | null;
  /** When true, format the primary value as a percent (grossMarginPct) instead of currency. */
  percentDenominated?: boolean;
  subLabel?: string;
}) {
  const primaryMissing = percentDenominated ? pct == null : cents == null;
  const primaryText = percentDenominated
    ? (pct == null ? EM_DASH : formatPercent(pct / 100))
    : formatCurrencyCents(cents);
  const subText = pct != null && !percentDenominated
    ? `${pct >= 0 ? "+" : ""}${formatPercent(pct / 100)} MoM`
    : subLabel;

  return (
    <Card padding="p-3" className="flex flex-col gap-1 min-w-0">
      <span className="text-xs text-muted uppercase tracking-wide truncate">{label}</span>
      <span className={`text-base sm:text-xl font-semibold font-mono tabular-nums ${primaryMissing ? "text-faint" : "text-primary"}`}>
        {primaryText}
      </span>
      {subText && <span className="text-xs text-muted truncate">{subText}</span>}
    </Card>
  );
}

function KpiStrip({ data }: { data: FinancialsResponse | undefined }) {
  const lastMonth = data?.months.at(-1);
  const kpis = data?.kpis;

  const netIncome     = lastMonth && kpis ? kpis.netIncomeCents[lastMonth] ?? null   : null;
  const grossMargin   = lastMonth && kpis ? kpis.grossMarginPct[lastMonth] ?? null   : null;
  const revenue       = lastMonth && kpis ? kpis.revenueCents[lastMonth] ?? null     : null;
  const revenueMoM    = lastMonth && kpis ? kpis.revenueMoMPct[lastMonth] ?? null    : null;
  const operatingCash = lastMonth && kpis?.operatingCashCents ? kpis.operatingCashCents[lastMonth] ?? null : null;
  const cashOnHand    = kpis?.cashOnHandCents ?? null;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
      <KpiTile label="Net Income" cents={netIncome} />
      <KpiTile label="Gross Margin" pct={grossMargin} percentDenominated />
      <KpiTile label="Revenue" cents={revenue} pct={revenueMoM} />
      <KpiTile label="Operating Cash" cents={operatingCash} subLabel={operatingCash == null ? "n/a" : undefined} />
      <KpiTile label="Cash on Hand" cents={cashOnHand} subLabel={cashOnHand == null ? "n/a" : undefined} />
    </div>
  );
}

/** Exclusive-choice chip group for Measure -- same visual language as FilterChips (app/components/ui/FilterChips.tsx) but with no "All"/off state, since exactly one measure is always active. */
function MeasureChips({ value, onChange }: { value: Measure; onChange: (v: Measure) => void }) {
  const chip = (selected: boolean) =>
    `text-xs px-2 py-0.5 rounded border transition-colors ${
      selected
        ? "border-accent-border bg-accent-muted/40 text-accent-soft"
        : "border-line-strong text-secondary hover:border-line-subtle hover:text-body"
    }`;
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-xs text-muted mr-0.5">Measure:</span>
      {MEASURE_OPTIONS.map((o) => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)} className={chip(value === o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function FinancialsClient({
  initialStatement,
  initialYear,
}: {
  initialStatement: StatementKind;
  initialYear: number;
}) {
  const [year, setYear] = useState(initialYear);
  const [statement, setStatement] = useState<StatementKind>(initialStatement);
  const [measure, setMeasure] = useState<Measure>("amount");
  const [showGlNumbers, setShowGlNumbers] = useState(true);
  const years = Array.from({ length: 3 }, (_, i) => initialYear - i);

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: queryKeys.finance.financials(statement, year),
    queryFn: () =>
      fetchJson<FinancialsResponse>(`/api/finance/financials?statement=${statement}&year=${year}`),
  });

  function handleStatementSelect(next: StatementKind) {
    setStatement(next);
    // BS/CF only ever report `$` -- drop back to amount so switching away from
    // P&L never leaves a BBL/$-per-BBL measure stuck on a statement that has
    // no volume dimension.
    if (next !== "pl") setMeasure("amount");
  }

  // Search/filter/sort config is dynamic (Total + one sort column per fetched
  // month) -- rebuild it whenever the month range changes, matching
  // ExportInvoicesTab.tsx's dynamic-config precedent for a config that closes
  // over fetched data.
  // A balance sheet's period figure is its CLOSING balance, not the sum of its
  // months -- summing point-in-time balances multiplies them. Both the rendered
  // column and the sort accessor take this from the same helper.
  const totalMode = useMemo(() => totalModeFor(statement), [statement]);
  const financialsControls = useMemo(
    () => buildFinancialsControls(data?.months ?? [], totalMode),
    [data?.months, totalMode],
  );

  const {
    rows: survivorRows, search, filters, sort, setSearch, setFilter, toggleSort, reset, activeCount,
  } = useTableControls(data?.rows ?? EMPTY_ROWS, financialsControls, { prefix: "fin_" });

  const sectionOptions = useMemo(() => {
    const seen = new Set<string>();
    const opts: { value: string; label: string }[] = [];
    for (const r of data?.rows ?? EMPTY_ROWS) {
      if (seen.has(r.statementSection)) continue;
      seen.add(r.statementSection);
      opts.push({ value: r.statementSection, label: SECTION_LABEL[r.statementSection as StatementSection] ?? r.statementSection });
    }
    return opts;
  }, [data]);

  // Flat-engine -> hierarchical-statement adaptation (spec §8): the engine
  // filters/sorts the flat rows, but buildTree needs a well-formed tree --
  // retainAncestors adds back any parent account rows a surviving child
  // needs so it never renders orphaned under nothing.
  const treeRows = useMemo(
    () => retainAncestors(survivorRows, data?.rows ?? EMPTY_ROWS),
    [survivorRows, data],
  );

  const tree = useMemo(
    () => (data ? buildTree(treeRows, statement, data.coaAccounts) : []),
    [data, treeRows, statement],
  );

  return (
    <div className="flex flex-col h-full bg-canvas text-primary">
      <FinanceNav mobile />
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-8">
        <div className="flex items-center justify-between">
          <PageHeader title="Financials" description="Consolidated P&L, Balance Sheet, and Cash Flow — persisted, CoA-mapped data" />
          <div className="flex items-center gap-2">
            {data && (
              <DataQualityPanel
                summary={data.dataQuality}
                onFilterQuality={(bucket) => setFilter("quality", [bucket])}
              />
            )}
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="inp-sm w-auto"
            >
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <button onClick={() => void refetch()} className="btn-primary">Refresh</button>
          </div>
        </div>

        <div className="flex items-center justify-between flex-wrap gap-2 mt-2">
          <TabBar tabs={STATEMENT_TABS} activeKey={statement} onSelect={handleStatementSelect} className="mb-0" />
        </div>
      </div>

      {error && (
        <Banner className="mx-4 sm:mx-6 mb-4 mt-4">
          {error instanceof Error ? error.message : "Failed to load"}
        </Banner>
      )}

      <CloseTasksBanner />

      <div className="flex-1 overflow-auto px-4 sm:px-6 pb-6 pt-4">
        <KpiStrip data={data} />

        <FilterBar activeCount={activeCount} onClear={reset} className="mb-4">
          <SearchInput
            value={search.q ?? ""}
            onChange={(v) => setSearch("q", v)}
            placeholder="Search accounts…"
          />
          <FilterChips
            label="Channel"
            options={CHANNEL_OPTIONS}
            value={filters.channel ?? []}
            onChange={(v) => setFilter("channel", v)}
            multiple
          />
          <FilterSelect
            label="Section"
            options={sectionOptions}
            value={filters.section ?? []}
            onChange={(v) => setFilter("section", v)}
          />
          <FilterChips
            label="Quality"
            options={QUALITY_OPTIONS}
            value={filters.quality ?? []}
            onChange={(v) => setFilter("quality", v)}
          />
          <FilterChips
            label="GL #"
            options={[{ value: "show", label: "Show" }]}
            value={showGlNumbers ? ["show"] : []}
            onChange={(v) => setShowGlNumbers(v.includes("show"))}
            allLabel="Hide"
          />
          {statement === "pl" && <MeasureChips value={measure} onChange={setMeasure} />}
        </FilterBar>

        {isFetching && !data && (
          <div className="flex items-center justify-center h-32">
            <p className="text-xs text-faint">Loading…</p>
          </div>
        )}

        {data && (
          <div className="bg-surface border border-line rounded-lg overflow-hidden">
            <FinancialsTable
              tree={tree}
              months={data.months}
              measure={measure}
              sort={sort}
              onSort={toggleSort}
              coaAccounts={data.coaAccounts}
              showGlNumbers={showGlNumbers}
              totalMode={totalMode}
            />
          </div>
        )}
      </div>
    </div>
  );
}
