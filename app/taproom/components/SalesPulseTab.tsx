"use client";

import { useState } from "react";
import { formatCurrencyCents } from "@/lib/format";
import { useQuery } from "@tanstack/react-query";
import { queryKeys, SALES_REPORT_STALE_TIME } from "@/lib/query-keys";
import dynamic from "next/dynamic";
import ChartSkeleton from "@/app/components/ChartSkeleton";
import TimezoneLabel from "@/app/components/TimezoneLabel";
import { useBreweryTimezone } from "@/app/hooks/useBreweryTimezone";
import { todayLocalDate, mondayOf, addDaysStr } from "@/lib/utils/datetime";
import { buildSalesWeekView, weekLabel, DAY_LABELS } from "@/lib/reports/salesPulseWeek";

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


const toggleBtn = (active: boolean) =>
  `px-3 py-1.5 text-xs font-medium transition-colors ${
    active ? "bg-surface-high text-primary" : "bg-surface-mid text-secondary hover:text-strong"
  }`;

export default function SalesPulseTab() {
  const { timezone } = useBreweryTimezone();
  // "Today" and every week/day boundary are resolved in the brewery timezone,
  // never the viewer's browser zone, so the grid lines up with the API's
  // brewery-local day buckets. See lib/reports/salesPulseWeek.ts.
  const todayStr = todayLocalDate(timezone);

  const [weekStart,      setWeekStart]      = useState<string>(() => mondayOf(todayLocalDate(timezone)));
  const [chartMetric,    setChartMetric]    = useState<KpiMetric>("net_sales");
  const [catDayFilter,   setCatDayFilter]   = useState<number | null>(null); // null = whole week; 0=Mon…6=Sun

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
          onClick={() => setWeekStart((w) => addDaysStr(w, -7))}
          className="btn-ghost"
        >
          ‹ Prev
        </button>
        <div className="text-sm font-medium text-strong text-center">
          {isCurrentWeek ? (
            <><span className="text-accent text-xs font-medium mr-2">This Week</span>{weekLabel(weekStart)}</>
          ) : weekLabel(weekStart)}
        </div>
        <button
          onClick={() => setWeekStart((w) => addDaysStr(w, 7))}
          disabled={isCurrentWeek}
          className="btn-ghost"
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
                <button key={value} onClick={() => setChartMetric(value)}
                  className={`px-2 py-1.5 text-xs font-medium rounded border transition-colors ${
                    chartMetric === value
                      ? "bg-surface-high text-primary border-line-subtle"
                      : "bg-surface-mid text-secondary border-line-strong hover:text-strong"
                  }`}>
                  {label}
                </button>
              ))}
            </div>
            {/* Desktop: horizontal strip */}
            <div className="hidden sm:flex rounded overflow-hidden border border-line-strong">
              {KPI_OPTIONS.map(({ value, label }) => (
                <button key={value} onClick={() => setChartMetric(value)} className={toggleBtn(chartMetric === value)}>
                  {label}
                </button>
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
          <button
            onClick={() => setCatDayFilter(null)}
            className={`shrink-0 px-2.5 py-1 rounded text-xs font-medium border transition-colors ${
              catDayFilter === null
                ? "border-accent-border bg-accent-muted/20 text-accent-soft"
                : "border-line-strong text-muted hover:text-body hover:border-line-subtle"
            }`}
          >
            All
          </button>
          {dayPills.map(({ label, index, isFuture }) => (
            <button
              key={index}
              onClick={() => !isFuture && setCatDayFilter(index)}
              disabled={isFuture}
              className={`shrink-0 px-2.5 py-1 rounded text-xs font-medium border transition-colors disabled:opacity-25 disabled:cursor-not-allowed ${
                catDayFilter === index
                  ? "border-accent-border bg-accent-muted/20 text-accent-soft"
                  : "border-line-strong text-muted hover:text-body hover:border-line-subtle"
              }`}
            >
              {label}
            </button>
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
                  return (
                    <tr
                      key={cat.id}
                      className={`border-b ${cat.excluded ? "border-line/30" : "border-line/60"}`}
                    >
                      <td className={`py-2.5 font-medium ${dim}`}>
                        {cat.label}
                        {cat.excluded && (
                          <span className="ml-2 text-xs font-normal text-disabled italic">excl.</span>
                        )}
                      </td>
                      <td className={`py-2.5 px-3 text-right ${mono}`}>
                        {cat.gross_sales_cents > 0 ? formatCurrency(cat.gross_sales_cents) : <span className="text-disabled">—</span>}
                      </td>
                      <td className={`py-2.5 px-3 text-right ${mono}`}>
                        {cat.discounts_cents > 0 ? <span className="text-danger/70">({formatCurrency(cat.discounts_cents)})</span> : <span className="text-disabled">—</span>}
                      </td>
                      <td className={`py-2.5 px-3 text-right ${mono}`}>
                        {cat.returns_cents > 0 ? <span className="text-danger/70">({formatCurrency(cat.returns_cents)})</span> : <span className="text-disabled">—</span>}
                      </td>
                      <td className={`py-2.5 px-3 text-right font-mono font-medium ${cat.excluded ? "text-faint" : "text-primary"}`}>
                        {cat.net_sales_cents > 0 ? formatCurrency(cat.net_sales_cents) : <span className="text-disabled">—</span>}
                      </td>
                      <td className={`py-2.5 pl-3 text-right ${mono}`}>
                        {cat.tax_cents > 0 ? formatCurrency(cat.tax_cents) : <span className="text-disabled">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {catNetTotal > 0 && (
                <tfoot>
                  <tr className="border-t border-line-strong text-strong font-semibold">
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
