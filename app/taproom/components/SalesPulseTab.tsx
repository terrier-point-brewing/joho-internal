"use client";

import { Fragment, useState } from "react";
import { formatCurrencyCents } from "@/lib/format";
import { useQuery } from "@tanstack/react-query";
import { queryKeys, SALES_REPORT_STALE_TIME } from "@/lib/query-keys";
import dynamic from "next/dynamic";
import ChartSkeleton from "@/app/components/ChartSkeleton";
import TimezoneLabel from "@/app/components/TimezoneLabel";
import { useBreweryTimezone } from "@/app/hooks/useBreweryTimezone";
import { todayLocalDate, mondayOf, addDaysStr } from "@/lib/utils/datetime";
import { buildSalesWeekView, weekLabel, DAY_LABELS } from "@/lib/reports/salesPulseWeek";
import ToggleChip from "@/app/components/ui/ToggleChip";
import type { TaproomLineContribution } from "@/types/reports";

const SalesPulseChart = dynamic(() => import("./SalesPulseChart"), {
  ssr: false,
  loading: () => <ChartSkeleton height={280} />,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type KpiMetric = "net_sales" | "gross_sales" | "avg_ticket" | "guest_count";

type DayData = {
  date: string;
  net_sales_cents: number;
  gross_sales_cents: number;
  order_count: number;
  avg_ticket_cents: number;
};

type CategoryData = {
  id: string;
  label: string;
  gross_sales_cents: number;
  discounts_cents: number;
  returns_cents: number;
  net_sales_cents: number;
  tax_cents: number;
  excluded: boolean;
};

type PulseData = {
  net_sales_cents: number;
  gross_sales_cents: number;
  order_count: number;
  avg_ticket_cents: number;
  by_category: CategoryData[];
  daily: DayData[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCurrency(cents: number, decimals = 0) {
  return formatCurrencyCents(cents, decimals);
}

function formatMetricValue(metric: KpiMetric, value: number): string {
  if (metric === "net_sales" || metric === "gross_sales") return formatCurrency(value);
  if (metric === "avg_ticket") return formatCurrency(value);
  return value.toLocaleString("en-US");
}

function getDayMetricValue(metric: KpiMetric, day: DayData): number {
  switch (metric) {
    case "net_sales":   return day.net_sales_cents / 100;
    case "gross_sales": return day.gross_sales_cents / 100;
    case "avg_ticket":  return day.avg_ticket_cents / 100;
    case "guest_count": return day.order_count;
  }
}

function pctChange(current: number, prior: number): number | null {
  if (prior === 0) return null;
  return ((current - prior) / prior) * 100;
}

// ---------------------------------------------------------------------------
// Category drill-down
// ---------------------------------------------------------------------------

// Which figure the reader clicked. The drill shows only that column, because a
// list filtered to "lines with a discount" cannot also foot to the category's
// gross — showing both would put two numbers on screen that disagree.
type DrillColumn = "gross" | "discounts" | "returns" | "net" | "tax";

const DRILL_LABELS: Record<DrillColumn, string> = {
  gross:     "Gross Sales",
  discounts: "Discounts",
  returns:   "Returns",
  net:       "Net Sales",
  tax:       "Tax",
};

// Most rows rendered before the list is truncated. The footer total still
// covers every line, and the header says how many are not on screen.
const DRILL_ROW_LIMIT = 250;

function drillValue(col: DrillColumn, c: TaproomLineContribution): number {
  switch (col) {
    case "gross":     return c.grossSalesCents;
    case "discounts": return c.discountsCents;
    case "returns":   return c.returnsCents;
    case "tax":       return c.taxCents;
    case "net":       return c.grossSalesCents - c.discountsCents - c.returnsCents;
  }
}

// The category figure the drill has to foot to.
function drillExpectedCents(cat: CategoryData, col: DrillColumn): number {
  switch (col) {
    case "gross":     return cat.gross_sales_cents;
    case "discounts": return cat.discounts_cents;
    case "returns":   return cat.returns_cents;
    case "tax":       return cat.tax_cents;
    case "net":       return cat.net_sales_cents;
  }
}

function formatLineTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// The line items that produced one cell of the category table. Their sum is
// shown in the footer and is the same figure as the cell that opened it — see
// TaproomLineContribution for why that holds by construction.
function CategoryDrill({
  lines, column, expectedCents, loading,
}: {
  lines: TaproomLineContribution[];
  column: DrillColumn;
  expectedCents: number;
  loading: boolean;
}) {
  const rows = lines
    .filter((c) => drillValue(column, c) !== 0)
    .sort((a, b) => Math.abs(drillValue(column, b)) - Math.abs(drillValue(column, a)));

  // The total covers every row; only the rendering is capped. A busy week can
  // put a couple of thousand lines behind one figure, and painting them all
  // stalls the page for a list nobody reads to the end.
  const total = rows.reduce((s, c) => s + drillValue(column, c), 0);
  const shown = rows.slice(0, DRILL_ROW_LIMIT);
  // Only in the discounts drill: elsewhere the column is mostly em-dashes,
  // since the biggest gross/net lines are usually the undiscounted ones.
  const showDiscountNames = column === "discounts";
  const anyProrated = shown.some((c) => c.prorated);

  if (loading) {
    return <div className="px-4 py-3 text-xs text-faint">Loading transactions…</div>;
  }

  if (rows.length === 0) {
    return <div className="px-4 py-3 text-xs text-faint italic">No transactions behind this figure.</div>;
  }

  return (
    <div className="bg-canvas border-y border-line/60 px-4 py-3">
      <div className="text-2xs text-faint uppercase tracking-wider mb-2">
        {DRILL_LABELS[column]} — {rows.length} {rows.length === 1 ? "line" : "lines"}
        {rows.length > shown.length && (
          <span className="normal-case tracking-normal text-muted">
            {" "}· showing the largest {shown.length}; the total below covers all {rows.length}
          </span>
        )}
      </div>

      {/* Capped height: the drill opens inside the category table, so an
          uncapped list pushes every category below it off the screen. */}
      <div className="overflow-auto max-h-80">
        <table className="w-full text-xs min-w-[520px]">
          <thead>
            <tr className="text-2xs text-faint uppercase tracking-wider border-b border-line/60">
              <th className="text-left py-1.5 font-medium">When</th>
              <th className="text-left py-1.5 px-3 font-medium">Item</th>
              <th className="text-right py-1.5 px-3 font-medium">Qty</th>
              {showDiscountNames && <th className="text-left py-1.5 px-3 font-medium">Discount</th>}
              <th className="text-left py-1.5 px-3 font-medium">Order</th>
              <th className="text-right py-1.5 pl-3 font-medium">{DRILL_LABELS[column]}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => (
              <tr key={`${c.orderId}:${c.lineUid}:${c.kind}`} className="border-b border-line/30">
                <td className="py-1.5 text-muted whitespace-nowrap">{formatLineTime(c.occurredAt)}</td>
                <td className="py-1.5 px-3 text-body">
                  {c.itemName}
                  {c.variationName && <span className="text-faint ml-1.5">{c.variationName}</span>}
                  {c.kind === "return" && (
                    <span className="ml-2 text-2xs text-danger/70 uppercase tracking-wider">return</span>
                  )}
                  {c.prorated && (
                    <span className="ml-2 text-2xs text-muted italic">est.</span>
                  )}
                </td>
                <td className="py-1.5 px-3 text-right font-mono text-muted tabular-nums">{c.quantity}</td>
                {showDiscountNames && (
                  <td className="py-1.5 px-3 text-muted">
                    {c.discountNames.length > 0 ? c.discountNames.join(", ") : <span className="text-disabled">—</span>}
                  </td>
                )}
                <td className="py-1.5 px-3 font-mono text-accent">{c.orderId.slice(-8)}</td>
                <td className="py-1.5 pl-3 text-right font-mono text-strong tabular-nums">
                  {formatCurrencyCents(drillValue(column, c), 2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Outside the scroll box on purpose — this is the figure that has to
          match the cell above, so it must never be scrolled out of view. */}
      <div className="flex items-center justify-between border-t border-line-strong pt-2 mt-1 text-xs font-semibold text-strong">
        <span>Total</span>
        <span className="font-mono tabular-nums">{formatCurrencyCents(total, 2)}</span>
      </div>

      {anyProrated && (
        <div className="mt-2 text-2xs text-muted italic">
          &ldquo;est.&rdquo; — Square sent this refund without per-line detail, so it was split across the
          order by value. No receipt shows that exact amount.
        </div>
      )}

      {/* The drill is emitted by the same code that produced the total, so this
          should never fire. If it ever does, the totals are the thing to trust
          and something upstream stopped reporting where its money came from. */}
      {total !== expectedCents && (
        <div className="mt-2 text-2xs text-danger">
          These lines total {formatCurrencyCents(total, 2)} but the category shows{" "}
          {formatCurrencyCents(expectedCents, 2)}. Report this — the breakdown is incomplete.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI card
// ---------------------------------------------------------------------------

function KpiCard({
  label, current, prior, metric,
}: {
  label: string;
  current: number | null;
  prior: number | null;
  metric: KpiMetric;
}) {
  const change = current !== null && prior !== null ? pctChange(current, prior) : null;
  const isUp = change !== null && change >= 0;

  return (
    <div className="bg-surface border border-line rounded-lg p-4">
      <div className="text-xs text-muted mb-1">{label}</div>
      <div className="text-base sm:text-xl font-semibold text-primary">
        {current !== null ? formatMetricValue(metric, current) : <span className="text-faint">—</span>}
      </div>
      {change !== null && (
        <div className={`text-xs mt-1 ${isUp ? "text-success" : "text-danger"}`}>
          {isUp ? "▲" : "▼"} {Math.abs(change).toFixed(1)}% vs prior week
        </div>
      )}
      {change === null && prior !== null && (
        <div className="text-xs mt-1 text-faint">No prior week data</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const KPI_OPTIONS: { value: KpiMetric; label: string }[] = [
  { value: "net_sales",   label: "Net Sales"          },
  { value: "gross_sales", label: "Gross Sales"         },
  { value: "avg_ticket",  label: "Avg Ticket Size"     },
  { value: "guest_count", label: "Guest Count"         },
];


export default function SalesPulseTab() {
  const { timezone } = useBreweryTimezone();
  // "Today" and every week/day boundary are resolved in the brewery timezone,
  // never the viewer's browser zone, so the grid lines up with the API's
  // brewery-local day buckets. See lib/reports/salesPulseWeek.ts.
  const todayStr = todayLocalDate(timezone);

  const [weekStart,      setWeekStart]      = useState<string>(() => mondayOf(todayLocalDate(timezone)));
  const [chartMetric,    setChartMetric]    = useState<KpiMetric>("net_sales");
  const [catDayFilter,   setCatDayFilter]   = useState<number | null>(null); // null = whole week; 0=Mon…6=Sun
  // Which category cell is drilled open. Cleared whenever the range changes, so
  // an open drill can never be showing a different period than the table.
  const [drill, setDrill] = useState<{ categoryId: string; column: DrillColumn } | null>(null);

  function changeWeek(delta: number) {
    setDrill(null);
    setWeekStart((w) => addDaysStr(w, delta));
  }

  function changeDayFilter(index: number | null) {
    setDrill(null);
    setCatDayFilter(index);
  }

  function toggleDrill(categoryId: string, column: DrillColumn) {
    setDrill((d) =>
      d && d.categoryId === categoryId && d.column === column ? null : { categoryId, column }
    );
  }

  const { curStart, priorStart, priorEnd, effectiveEnd, isCurrentWeek, dayPills } =
    buildSalesWeekView(weekStart, todayStr);

  async function fetchPulse(start: string, end: string): Promise<PulseData | null> {
    const res = await fetch(`/api/sales-pulse?start=${start}&end=${end}`);
    if (!res.ok) return null;
    return res.json();
  }

  const { data: currentData = null, isLoading: loading } = useQuery({
    queryKey: queryKeys.taproom.salesPulse(curStart, effectiveEnd),
    queryFn: () => fetchPulse(curStart, effectiveEnd),
    staleTime: SALES_REPORT_STALE_TIME,
  });
  const { data: priorData = null } = useQuery({
    queryKey: queryKeys.taproom.salesPulse(priorStart, priorEnd),
    queryFn: () => fetchPulse(priorStart, priorEnd),
    staleTime: SALES_REPORT_STALE_TIME,
  });

  // Per-day category breakdown — only fetched when day filter is active.
  const dayDate     = catDayFilter !== null ? dayPills[catDayFilter].dateStr : null;
  const dayIsFuture = catDayFilter !== null ? dayPills[catDayFilter].isFuture : false;
  const { data: catDayData = null, isLoading: catDayLoading } = useQuery({
    queryKey: queryKeys.taproom.salesPulseDay(dayDate ?? ""),
    queryFn: () => fetchPulse(dayDate!, dayDate!),
    staleTime: SALES_REPORT_STALE_TIME,
    enabled: dayDate !== null && !dayIsFuture,
  });

  // Line-level detail behind the category table. Fetched against exactly the
  // range the table is showing, and only once a drill is actually open — the
  // route costs a full Square round-trip. One fetch covers every category, so
  // opening a second one is instant.
  const catStart = catDayFilter !== null ? (dayDate ?? "") : curStart;
  const catEnd   = catDayFilter !== null ? (dayDate ?? "") : effectiveEnd;
  const { data: lineData = null, isLoading: linesLoading } = useQuery({
    queryKey: queryKeys.taproom.salesPulseLines(catStart, catEnd),
    queryFn: async (): Promise<{ lines: TaproomLineContribution[] } | null> => {
      const res = await fetch(`/api/sales-pulse/lines?start=${catStart}&end=${catEnd}`);
      if (!res.ok) return null;
      return res.json();
    },
    staleTime: SALES_REPORT_STALE_TIME,
    enabled: drill !== null && catStart !== "" && !dayIsFuture,
  });

  const drillLines = drill
    ? (lineData?.lines ?? []).filter((c) => c.categoryId === drill.categoryId)
    : [];

  // ---------------------------------------------------------------------------
  // Chart data — align both weeks on Mon–Sun index
  // ---------------------------------------------------------------------------

  const chartData = DAY_LABELS.map((day, i) => {
    const curDay  = currentData?.daily[i];
    const priorDay = priorData?.daily[i];
    return {
      day,
      "This Week": curDay  ? getDayMetricValue(chartMetric, curDay)  : undefined,
      "Prior Week": priorDay ? getDayMetricValue(chartMetric, priorDay) : undefined,
    };
  });

  // ---------------------------------------------------------------------------
  // Category table — source switches between full-week and single-day data
  // ---------------------------------------------------------------------------

  const catSource = catDayFilter !== null ? catDayData : currentData;

  const sortedCategories = catSource
    ? [...catSource.by_category].sort((a, b) => {
        if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
        return b.net_sales_cents - a.net_sales_cents;
      })
    : [];

  const catNetTotal   = catSource?.by_category.filter((c) => !c.excluded).reduce((s, c) => s + c.net_sales_cents,   0) ?? 0;
  const catGrossTotal = catSource?.by_category.filter((c) => !c.excluded).reduce((s, c) => s + c.gross_sales_cents, 0) ?? 0;
  const catDiscTotal  = catSource?.by_category.filter((c) => !c.excluded).reduce((s, c) => s + c.discounts_cents,   0) ?? 0;
  const catRetTotal   = catSource?.by_category.filter((c) => !c.excluded).reduce((s, c) => s + c.returns_cents,     0) ?? 0;
  const catTaxTotal   = catSource?.by_category.filter((c) => !c.excluded).reduce((s, c) => s + c.tax_cents,         0) ?? 0;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-6 max-w-5xl">

      {/* Week selector */}
      <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
        <button
          onClick={() => changeWeek(-7)}
          className="btn-secondary"
        >
          ‹ Prev
        </button>
        <div className="text-sm font-medium text-strong text-center">
          {isCurrentWeek ? (
            <><span className="text-accent text-xs font-medium mr-2">This Week</span>{weekLabel(weekStart)}</>
          ) : weekLabel(weekStart)}
        </div>
        <button
          onClick={() => changeWeek(7)}
          disabled={isCurrentWeek}
          className="btn-secondary"
        >
          Next ›
        </button>
        {loading && <span className="text-xs text-muted ml-2">Loading…</span>}
        <TimezoneLabel className="w-full sm:w-auto sm:ml-auto" />
      </div>

      {/* 4 KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <KpiCard
          label="Net Sales"
          metric="net_sales"
          current={currentData?.net_sales_cents ?? null}
          prior={priorData?.net_sales_cents ?? null}
        />
        <KpiCard
          label="Gross Sales"
          metric="gross_sales"
          current={currentData?.gross_sales_cents ?? null}
          prior={priorData?.gross_sales_cents ?? null}
        />
        <KpiCard
          label="Avg Ticket Size"
          metric="avg_ticket"
          current={currentData?.avg_ticket_cents ?? null}
          prior={priorData?.avg_ticket_cents ?? null}
        />
        <KpiCard
          label="Guest Count"
          metric="guest_count"
          current={currentData?.order_count ?? null}
          prior={priorData?.order_count ?? null}
        />
      </div>

      {/* Chart */}
      <div className="bg-surface border border-line rounded-lg p-3 sm:p-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
          <div className="text-sm font-medium text-body">Daily Performance</div>
          <div className="flex items-start sm:items-center gap-2">
            <span className="text-xs text-muted shrink-0 pt-1.5 sm:pt-0">Metric</span>
            {/* Mobile: 2×2 grid */}
            <div className="sm:hidden grid grid-cols-2 gap-1 flex-1">
              {KPI_OPTIONS.map(({ value, label }) => (
                <ToggleChip key={value} active={chartMetric === value} onClick={() => setChartMetric(value)}>
                  {label}
                </ToggleChip>
              ))}
            </div>
            {/* Desktop: horizontal strip */}
            <div className="hidden sm:flex items-center gap-1">
              {KPI_OPTIONS.map(({ value, label }) => (
                <ToggleChip key={value} active={chartMetric === value} onClick={() => setChartMetric(value)}>
                  {label}
                </ToggleChip>
              ))}
            </div>
          </div>
        </div>

        <SalesPulseChart chartData={chartData} chartMetric={chartMetric} />
      </div>

      {/* Category breakdown */}
      <div className="bg-surface border border-line rounded-lg p-3 sm:p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-medium text-body">Category Breakdown</div>
        </div>

        {/* Day-of-week filter */}
        <div className="flex items-center gap-1.5 mb-4 overflow-x-auto scrollbar-none pb-0.5">
          <span className="text-xs text-faint mr-1">Day</span>
          <ToggleChip active={catDayFilter === null} onClick={() => changeDayFilter(null)} className="shrink-0">
            All
          </ToggleChip>
          {dayPills.map(({ label, index, isFuture }) => (
            <ToggleChip
              key={index}
              active={catDayFilter === index}
              onClick={() => !isFuture && changeDayFilter(index)}
              className={`shrink-0 ${isFuture ? "opacity-25 pointer-events-none" : ""}`}
            >
              {label}
            </ToggleChip>
          ))}
          {catDayLoading && <span className="text-xs text-faint ml-1">Loading…</span>}
        </div>

        {!currentData && !loading && (
          <div className="text-sm text-faint italic">No data loaded.</div>
        )}

        {catSource && (
          <>
            <div className="flex items-center gap-4 mb-3 text-xs text-muted">
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-3 h-0.5 bg-text-secondary rounded" />
                Included in taproom net sales
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-3 h-0.5 bg-surface-high rounded" />
                Excluded
              </span>
            </div>

            <div className="overflow-x-auto -mx-5 px-5">
            <table className="w-full text-sm min-w-[540px]">
              <thead>
                <tr className="text-xs text-muted uppercase border-b border-line">
                  <th className="text-left py-2 font-medium w-5" />
                  <th className="text-left py-2 font-medium">Category</th>
                  <th className="text-right py-2 px-3 font-medium">Gross Sales</th>
                  <th className="text-right py-2 px-3 font-medium">Discounts</th>
                  <th className="text-right py-2 px-3 font-medium">Returns</th>
                  <th className="text-right py-2 px-3 font-medium">Net Sales</th>
                  <th className="text-right py-2 pl-3 font-medium">Tax</th>
                </tr>
              </thead>
              <tbody>
                {sortedCategories.map((cat) => {
                  const dim = cat.excluded ? "text-faint" : "text-strong";
                  const mono = `font-mono ${dim}`;
                  const open = drill?.categoryId === cat.id;

                  // Every populated figure opens the lines behind it. An empty
                  // cell has nothing to show, so it stays inert rather than
                  // offering a click that opens an empty panel.
                  const cell = (column: DrillColumn, cents: number, content: React.ReactNode, cls: string) => (
                    <td
                      className={`py-2.5 text-right ${cls} ${
                        cents > 0
                          ? `cursor-pointer hover:bg-surface-mid/40 ${drill?.categoryId === cat.id && drill.column === column ? "bg-surface-mid/60" : ""}`
                          : ""
                      }`}
                      onClick={cents > 0 ? () => toggleDrill(cat.id, column) : undefined}
                    >
                      {content}
                    </td>
                  );

                  return (
                    <Fragment key={cat.id}>
                      <tr className={`border-b ${cat.excluded ? "border-line/30" : "border-line/60"}`}>
                        <td
                          className="py-2.5 w-5 text-faint text-2xs cursor-pointer"
                          onClick={() => toggleDrill(cat.id, "net")}
                        >
                          {open ? "▾" : "▸"}
                        </td>
                        <td
                          className={`py-2.5 font-medium ${dim} cursor-pointer hover:text-primary`}
                          onClick={() => toggleDrill(cat.id, "net")}
                        >
                          {cat.label}
                          {cat.excluded && (
                            <span className="ml-2 text-xs font-normal text-disabled italic">excl.</span>
                          )}
                        </td>
                        {cell("gross", cat.gross_sales_cents, cat.gross_sales_cents > 0 ? formatCurrency(cat.gross_sales_cents) : <span className="text-disabled">—</span>, `px-3 ${mono}`)}
                        {cell("discounts", cat.discounts_cents, cat.discounts_cents > 0 ? <span className="text-danger/70">({formatCurrency(cat.discounts_cents)})</span> : <span className="text-disabled">—</span>, `px-3 ${mono}`)}
                        {cell("returns", cat.returns_cents, cat.returns_cents > 0 ? <span className="text-danger/70">({formatCurrency(cat.returns_cents)})</span> : <span className="text-disabled">—</span>, `px-3 ${mono}`)}
                        {cell("net", cat.net_sales_cents, cat.net_sales_cents > 0 ? formatCurrency(cat.net_sales_cents) : <span className="text-disabled">—</span>, `px-3 font-mono font-medium ${cat.excluded ? "text-faint" : "text-primary"}`)}
                        {cell("tax", cat.tax_cents, cat.tax_cents > 0 ? formatCurrency(cat.tax_cents) : <span className="text-disabled">—</span>, `pl-3 ${mono}`)}
                      </tr>

                      {open && drill && (
                        <tr>
                          <td colSpan={7} className="p-0">
                            <CategoryDrill
                              lines={drillLines}
                              column={drill.column}
                              expectedCents={drillExpectedCents(cat, drill.column)}
                              loading={linesLoading}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
              {catNetTotal > 0 && (
                <tfoot>
                  <tr className="border-t border-line-strong text-strong font-semibold">
                    <td className="py-2" />
                    <td className="py-2">Total (included)</td>
                    <td className="py-2 px-3 text-right font-mono">{formatCurrency(catGrossTotal)}</td>
                    <td className="py-2 px-3 text-right font-mono text-danger/70">
                      {catDiscTotal > 0 ? `(${formatCurrency(catDiscTotal)})` : "—"}
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-danger/70">
                      {catRetTotal > 0 ? `(${formatCurrency(catRetTotal)})` : "—"}
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-primary">{formatCurrency(catNetTotal)}</td>
                    <td className="py-2 pl-3 text-right font-mono">{formatCurrency(catTaxTotal)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
            </div>
          </>
        )}
      </div>

    </div>
  );
}
