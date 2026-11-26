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

import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import { formatCurrencyCents, formatPercent, EM_DASH } from "@/lib/format";
import type { FinancialsResponse, FinancialsRow, Measure, StatementKind } from "@/lib/finance/financials/types";
import type { StatementSection } from "@/lib/finance/accountSections";
import PageHeader from "@/app/components/PageHeader";
import TitleRow from "@/app/components/ui/TitleRow";
import StickyHeader from "@/app/components/StickyHeader";
import Banner from "@/app/components/ui/Banner";
import Card from "@/app/components/ui/Card";
import TabBar, { type TabDef } from "@/app/components/TabBar";
import { useTableControls } from "@/app/components/ui/useTableControls";
import SearchInput from "@/app/components/ui/SearchInput";
import ToggleChip from "@/app/components/ui/ToggleChip";
import FilterChips from "@/app/components/ui/FilterChips";
import FilterSelect from "@/app/components/ui/FilterSelect";
import Popover from "@/app/components/ui/Popover";
import FilterBar from "@/app/components/ui/FilterBar";
import FinanceNav from "../FinanceNav";
import CloseTasksBanner from "../CloseTasksBanner";
import FinancialsTable from "./FinancialsTable";
import DataQualityPanel from "./DataQualityPanel";
import ExportButton from "./ExportButton";
import { buildTree, type TreeNode } from "./buildTree";
import { buildFinancialsControls, retainAncestors, CHANNEL_OPTIONS, QUALITY_OPTIONS, SECTION_LABEL } from "./controls";
import { totalModeFor } from "@/lib/finance/financials/statementTotal";
import SpendWatchTab, { type SpendBasis } from "./SpendWatchTab";
import { defaultFocusMonth } from "@/lib/finance/financials/spendWatch";
import { todayLocalDate } from "@/lib/utils/datetime";
import { actualsByMonth, buildBalanceSheetForecast, buildForecast, methodKey } from "@/lib/finance/forecast/forecast";
import type { ForecastAssumptions, ForecastDrivers } from "@/lib/finance/forecast/types";
import { ForecastAssumptionsModal, ForecastOverview, changedLeverCount, useForecastSettings, type ScenarioForecast } from "./ForecastPanel";

/**
 * What the tab bar switches between: the three statements, plus Spend Watch,
 * which is not a statement of its own but a reading of one (the P&L or the
 * cash flow, per its basis toggle) and so reuses that statement's query.
 */
export type FinancialsView = StatementKind | "spend_watch";

// Stable empty-array reference so useTableControls/useMemo deps don't churn
// on every render while `data` is still loading (a fresh `[]` literal would
// be a new reference each time).
const EMPTY_ROWS: FinancialsRow[] = [];

const STATEMENT_TABS: TabDef<FinancialsView>[] = [
  { key: "pl",            label: "P&L" },
  { key: "balance_sheet", label: "Balance Sheet" },
  { key: "cash_flow",     label: "Cash Flow" },
  { key: "spend_watch",   label: "Spend Watch" },
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

/** A single stat tile. A KPI the statement does not carry renders nothing — not "n/a". */
function KpiTile({ label, cents, pct, percentDenominated, subLabel }: {
  label: string;
  cents?: number | null;
  pct?: number | null;
  /** When true, format the primary value as a percent (grossMarginPct) instead of currency. */
  percentDenominated?: boolean;
  subLabel?: string;
}) {
  const primaryMissing = percentDenominated ? pct == null : cents == null;
  if (primaryMissing) return null;
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
  const burnRate      = kpis?.burnRateCents ?? null;
  const runway        = kpis?.runwayMonths ?? null;

  // The lifeline, said in one line under the cash figure. A burn quotes months
  // of runway at the trailing average; positive operating cash means there is
  // no countdown to quote, which is worth saying outright rather than leaving
  // the tile mute. Only the cash-flow statement carries these fields; on the
  // others the tile is simply absent.
  const cashSubLabel =
    runway != null ? `≈ ${runway} months of runway at the current burn`
    : burnRate != null && burnRate >= 0 ? "cash-flow positive — no burn to outrun"
    : undefined;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
      <KpiTile label="Net Income" cents={netIncome} />
      <KpiTile label="Gross Margin" pct={grossMargin} percentDenominated />
      <KpiTile label="Revenue" cents={revenue} pct={revenueMoM} />
      <KpiTile label="Operating Cash" cents={operatingCash} />
      <KpiTile label="Cash on Hand" cents={cashOnHand} subLabel={cashSubLabel} />
    </div>
  );
}

/**
 * The View menu: how the table is drawn, as opposed to which rows it shows.
 * GL numbers and the P&L's measure are display choices, so they live behind
 * one button rather than beside the filters. Measure is an exclusive choice
 * with no "All"/off state, so it is a ToggleChip row rather than FilterChips.
 */
function ViewMenu({
  showGlNumbers,
  onShowGlNumbers,
  measure,
  onMeasure,
  measureAvailable,
}: {
  showGlNumbers: boolean;
  onShowGlNumbers: (v: boolean) => void;
  measure: Measure;
  onMeasure: (v: Measure) => void;
  measureAvailable: boolean;
}) {
  return (
    <Popover label="View">
      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-xs text-body">
          <input type="checkbox" checked={showGlNumbers} onChange={(e) => onShowGlNumbers(e.target.checked)} />
          Show GL numbers
        </label>
        {measureAvailable && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-muted mr-0.5">Measure:</span>
            {MEASURE_OPTIONS.map((o) => (
              <ToggleChip key={o.value} active={measure === o.value} onClick={() => onMeasure(o.value)}>
                {o.label}
              </ToggleChip>
            ))}
          </div>
        )}
      </div>
    </Popover>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function FinancialsClient({
  initialStatement,
  initialYear,
}: {
  initialStatement: FinancialsView;
  initialYear: number;
}) {
  const [year, setYear] = useState(initialYear);
  const [view, setView] = useState<FinancialsView>(initialStatement);
  const [spendBasis, setSpendBasis] = useState<SpendBasis>("pl");
  const [focusMonth, setFocusMonth] = useState<string | null>(null);
  const [measure, setMeasure] = useState<Measure>("amount");
  const [showGlNumbers, setShowGlNumbers] = useState(true);
  const years = Array.from({ length: 3 }, (_, i) => initialYear - i);

  // Spend Watch reads the P&L or cash-flow statement it is set to; the three
  // statement tabs read themselves. One query either way, keyed on the
  // statement actually fetched, so flipping to Spend Watch on the P&L basis
  // is a cache hit when the P&L tab was just open.
  const statement: StatementKind = view === "spend_watch" ? spendBasis : view;

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: queryKeys.finance.financials(statement, year),
    queryFn: () =>
      fetchJson<FinancialsResponse>(`/api/finance/financials?statement=${statement}&year=${year}`),
  });

  function handleStatementSelect(next: FinancialsView) {
    setView(next);
    // BS/CF only ever report `$` -- drop back to amount so switching away from
    // P&L never leaves a BBL/$-per-BBL measure stuck on a statement that has
    // no volume dimension.
    if (next !== "pl") setMeasure("amount");
  }

  const openMonth = todayLocalDate().slice(0, 7);

  // ── Forecast ───────────────────────────────────────────────────────────────
  // One switch for the whole page. It projects the P&L and the cash flow from
  // their own recent months, and rolls the balance sheet forward from those two
  // — so all three statements are fetched while it is on, whichever tab is
  // showing. A past year has nothing left to project.
  const forecast = useForecastSettings();
  const [assumptionsOpen, setAssumptionsOpen] = useState(false);
  const forecastAvailable = view !== "spend_watch" && year === initialYear;
  const forecastActive = forecast.on && forecastAvailable;

  const { data: drivers, error: driversError } = useQuery({
    queryKey: queryKeys.finance.forecastDrivers(),
    queryFn: () => fetchJson<ForecastDrivers>("/api/finance/forecast"),
    enabled: forecastActive,
    staleTime: 5 * 60_000,
  });
  // Same keys as the statement query above, so the tab on screen is never
  // fetched twice and its forecast is built from the very rows it renders.
  const { data: plData } = useQuery({
    queryKey: queryKeys.finance.financials("pl", year),
    queryFn: () => fetchJson<FinancialsResponse>(`/api/finance/financials?statement=pl&year=${year}`),
    enabled: forecastActive,
  });
  const { data: cashFlowData } = useQuery({
    queryKey: queryKeys.finance.financials("cash_flow", year),
    queryFn: () => fetchJson<FinancialsResponse>(`/api/finance/financials?statement=cash_flow&year=${year}`),
    enabled: forecastActive,
  });

  /** Both flow forecasts for one set of assumptions — the scenario on screen, or one being compared against it. */
  const runScenario = useCallback(
    (assumptions: ForecastAssumptions): ScenarioForecast => {
      const one = (source: FinancialsResponse | undefined, kind: "pl" | "cash_flow") =>
        source && drivers
          ? buildForecast({ rows: source.rows, months: source.months, coaAccounts: source.coaAccounts, statement: kind, drivers, assumptions })
          : null;
      return { pl: one(plData, "pl"), cashFlow: one(cashFlowData, "cash_flow") };
    },
    [plData, cashFlowData, drivers],
  );
  const scenario = useMemo(
    () => (forecastActive && drivers ? runScenario(forecast.assumptions) : null),
    [forecastActive, drivers, runScenario, forecast.assumptions],
  );
  const forecastResult = useMemo(() => {
    if (!scenario || !data) return null;
    if (statement === "pl") return scenario.pl;
    if (statement === "cash_flow") return scenario.cashFlow;
    return scenario.pl && scenario.cashFlow
      ? buildBalanceSheetForecast({ rows: data.rows, months: data.months, coaAccounts: data.coaAccounts, pl: scenario.pl, cashFlow: scenario.cashFlow })
      : null;
  }, [scenario, data, statement]);
  const statementRows = forecastResult?.rows ?? data?.rows ?? EMPTY_ROWS;
  const forecastColumns = useMemo(() => {
    if (!forecastResult) return undefined;
    const byKey = forecastResult.methodByKey;
    return {
      months: forecastResult.forecastMonths,
      openMonth: forecastResult.restKey ? forecastResult.openMonth : null,
      restKey: forecastResult.restKey,
      methodFor: (row: FinancialsRow) => byKey[methodKey(row, row.channel)] ?? byKey[methodKey(row, "*")],
    };
  }, [forecastResult]);
  // The accuracy check compares saved forecasts with actuals; the balance
  // sheet has no flow of its own, so there it reads the P&L.
  const accuracy = useMemo(() => {
    const kind = statement === "cash_flow" ? "cash_flow" : "pl";
    const source = kind === "cash_flow" ? cashFlowData : plData;
    return source ? { statement: kind, actuals: actualsByMonth(source.rows, source.months) } as const : null;
  }, [statement, plData, cashFlowData]);
  const resolvedFocusMonth =
    focusMonth && data?.months.includes(focusMonth)
      ? focusMonth
      : (data ? defaultFocusMonth(data.months, openMonth) : null);

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
  } = useTableControls(statementRows, financialsControls, { prefix: "fin_" });

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
    () => retainAncestors(survivorRows, statementRows),
    [survivorRows, statementRows],
  );

  const tree = useMemo(
    // data.months bounds the period ratios: with the forecast on, the rows
    // carry projected months that must not move a Total.
    () => {
      if (!data) return [];
      const built = buildTree(treeRows, statement, data.coaAccounts, data.months);
      // The cash-flow forecast's runway, as a line of its own under Net
      // Operating. A balance on a flow statement, so it closes rather than sums.
      const cashRow = statement === "cash_flow" ? forecastResult?.cashRow : null;
      if (cashRow) {
        const cashNode: TreeNode = { row: cashRow, label: "Projected cash at month end", children: [], depth: 0, isSection: false, totalMode: "closing" };
        built.push(cashNode);
      }
      return built;
    },
    [data, treeRows, statement, forecastResult],
  );

  return (
    <div className="frame bg-canvas text-primary">
      <div className="shrink-0 px-4 sm:px-6">
        <StickyHeader>
          <FinanceNav mobile />
          <TitleRow
            title={<PageHeader title="Financials" description="Monthly statements" />}
            actions={<>
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
              <ExportButton year={year} />
              <button onClick={() => void refetch()} className="btn-primary">Refresh</button>
            </>}
          />
          <TabBar tabs={STATEMENT_TABS} activeKey={view} onSelect={handleStatementSelect} className="mb-0" />
        </StickyHeader>
      </div>

      {error && (
        <Banner className="mx-4 sm:mx-6 mb-4 mt-4">
          {error instanceof Error ? error.message : "Failed to load"}
        </Banner>
      )}

      <CloseTasksBanner />

      {view === "spend_watch" ? (
        <div className="pane px-4 sm:px-6 pb-6 pt-4">
          {isFetching && !data && (
            <div className="flex items-center justify-center h-32">
              <p className="text-xs text-faint">Loading…</p>
            </div>
          )}
          {data && resolvedFocusMonth && (
            <SpendWatchTab
              data={data}
              basis={spendBasis}
              onBasisChange={setSpendBasis}
              openMonth={openMonth}
              focusMonth={resolvedFocusMonth}
              onFocusMonthChange={setFocusMonth}
            />
          )}
        </div>
      ) : (
      <div className="pane px-4 sm:px-6 pb-6 pt-4">
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
          <ViewMenu
            showGlNumbers={showGlNumbers}
            onShowGlNumbers={setShowGlNumbers}
            measure={measure}
            onMeasure={setMeasure}
            measureAvailable={statement === "pl"}
          />
          <div className="flex items-center gap-1.5">
            <span title={forecastAvailable ? undefined : "The forecast covers the current year"}>
              <ToggleChip active={forecastActive} disabled={!forecastAvailable} onClick={() => forecast.setOn(!forecast.on)}>
                Forecast
              </ToggleChip>
            </span>
            {forecastActive && drivers && (
              <button type="button" className="btn-secondary" onClick={() => setAssumptionsOpen(true)}>
                Assumptions{changedLeverCount(forecast.assumptions) > 0 ? ` (${changedLeverCount(forecast.assumptions)})` : ""}
              </button>
            )}
          </div>
        </FilterBar>

        {forecastActive && driversError && (
          <Banner className="mb-4">
            Forecast unavailable: {driversError instanceof Error ? driversError.message : "failed to load"}
          </Banner>
        )}
        {forecastActive && data && drivers && plData && cashFlowData && !forecastResult && (
          <Banner className="mb-4">No finished month to forecast from yet.</Banner>
        )}
        {forecastResult && scenario && drivers && (
          <ForecastOverview
            scenario={scenario}
            drivers={drivers}
            statement={statement}
            assumptions={forecast.assumptions}
            onUse={forecast.setAssumptions}
            run={runScenario}
            accuracy={accuracy}
          />
        )}
        {assumptionsOpen && drivers && (
          <ForecastAssumptionsModal
            assumptions={forecast.assumptions}
            onChange={forecast.setAssumptions}
            drivers={drivers}
            forecastMonths={forecastResult?.forecastMonths ?? []}
            onClose={() => setAssumptionsOpen(false)}
          />
        )}

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
              forecast={forecastColumns}
            />
          </div>
        )}
      </div>
      )}
    </div>
  );
}
