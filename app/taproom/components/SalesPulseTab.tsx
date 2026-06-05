"use client";

import { useEffect, useState, useCallback } from "react";
import {
  ResponsiveContainer, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";

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

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function toISO(d: Date) {
  return d.toISOString().slice(0, 10);
}

function getMondayOf(d: Date): Date {
  const day = d.getDay(); // 0=Sun, 1=Mon ...
  const diff = (day === 0 ? -6 : 1 - day);
  const mon = new Date(d);
  mon.setDate(d.getDate() + diff);
  mon.setHours(0, 0, 0, 0);
  return mon;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function weekLabel(mon: Date): string {
  const sun = addDays(mon, 6);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  return `${mon.toLocaleDateString("en-US", opts)} – ${sun.toLocaleDateString("en-US", opts)}`;
}

function formatCurrency(cents: number, decimals = 0) {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency", currency: "USD",
    minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  });
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
// Custom tooltip
// ---------------------------------------------------------------------------

function ChartTooltip({
  active, payload, label, metric,
}: {
  active?: boolean;
  payload?: { name: string; value: number; color: string; strokeDasharray?: string }[];
  label?: string;
  metric: KpiMetric;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-xs shadow-lg">
      <div className="text-zinc-300 font-medium mb-1">{label}</div>
      {payload.map((p) => (
        <div key={p.name} style={{ color: p.color }} className="flex justify-between gap-4">
          <span>{p.name}</span>
          <span className="font-mono">
            {metric === "guest_count"
              ? Math.round(p.value ?? 0).toLocaleString()
              : formatCurrency((p.value ?? 0) * 100)}
          </span>
        </div>
      ))}
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
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <div className="text-xs text-zinc-500 mb-1">{label}</div>
      <div className="text-xl font-semibold text-zinc-100">
        {current !== null ? formatMetricValue(metric, current) : <span className="text-zinc-600">—</span>}
      </div>
      {change !== null && (
        <div className={`text-xs mt-1 ${isUp ? "text-green-400" : "text-red-400"}`}>
          {isUp ? "▲" : "▼"} {Math.abs(change).toFixed(1)}% vs prior week
        </div>
      )}
      {change === null && prior !== null && (
        <div className="text-xs mt-1 text-zinc-600">No prior week data</div>
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
    active ? "bg-zinc-700 text-zinc-100" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
  }`;

export default function SalesPulseTab() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [weekStart,      setWeekStart]      = useState<Date>(() => getMondayOf(today));
  const [chartMetric,    setChartMetric]    = useState<KpiMetric>("net_sales");
  const [catDayFilter,   setCatDayFilter]   = useState<number | null>(null); // null = whole week; 0=Mon…6=Sun
  const [currentData,    setCurrentData]    = useState<PulseData | null>(null);
  const [priorData,      setPriorData]      = useState<PulseData | null>(null);
  const [catDayData,     setCatDayData]     = useState<PulseData | null>(null);
  const [catDayLoading,  setCatDayLoading]  = useState(false);
  const [loading,        setLoading]        = useState(false);

  const fetchPulse = useCallback(async (start: string, end: string): Promise<PulseData | null> => {
    const res = await fetch(`/api/sales-pulse?start=${start}&end=${end}`);
    if (!res.ok) return null;
    return res.json();
  }, []);

  useEffect(() => {
    setLoading(true);
    setCurrentData(null);
    setPriorData(null);

    const curEnd = toISO(addDays(weekStart, 6));
    const priorStart = toISO(addDays(weekStart, -7));
    const priorEnd   = toISO(addDays(weekStart, -1));
    const todayStr   = toISO(today);

    // Cap current week end at today
    const effectiveEnd = curEnd < todayStr ? curEnd : todayStr;

    Promise.all([
      fetchPulse(toISO(weekStart), effectiveEnd),
      fetchPulse(priorStart, priorEnd),
    ]).then(([cur, prior]) => {
      setCurrentData(cur);
      setPriorData(prior);
      setLoading(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart]);

  // Fetch category data for a specific day when the day filter is active
  useEffect(() => {
    if (catDayFilter === null) { setCatDayData(null); return; }
    const dayDate  = addDays(weekStart, catDayFilter);
    const dateStr  = toISO(dayDate);
    const todayStr = toISO(today);
    // Don't fetch future days
    if (dateStr > todayStr) { setCatDayData(null); return; }
    setCatDayLoading(true);
    setCatDayData(null);
    fetchPulse(dateStr, dateStr).then((d) => {
      setCatDayData(d);
      setCatDayLoading(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catDayFilter, weekStart]);

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

  // chart values: dollars (not cents) for money metrics, raw count for guest_count
  const yAxisFmt = (v: number) => {
    if (chartMetric === "guest_count") return String(v);
    if (v >= 1000) return `$${(v / 1000).toFixed(0)}k`;
    return `$${v.toFixed(0)}`;
  };

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

  // Day pills — only show days that have started (≤ today)
  const todayStr = toISO(today);
  const dayPills = DAY_LABELS.map((label, i) => {
    const date    = addDays(weekStart, i);
    const dateStr = toISO(date);
    return { label, i, dateStr, isFuture: dateStr > todayStr };
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const isCurrentWeek = toISO(weekStart) === toISO(getMondayOf(today));

  return (
    <div className="space-y-6 max-w-5xl">

      {/* Week selector */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => setWeekStart((w) => addDays(w, -7))}
          className="px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded hover:bg-zinc-700 text-zinc-300"
        >
          ‹ Prev
        </button>
        <div className="text-sm font-medium text-zinc-200 min-w-[180px] text-center">
          {isCurrentWeek ? (
            <><span className="text-amber-400 text-xs font-medium mr-2">This Week</span>{weekLabel(weekStart)}</>
          ) : weekLabel(weekStart)}
        </div>
        <button
          onClick={() => setWeekStart((w) => addDays(w, 7))}
          disabled={isCurrentWeek}
          className="px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded hover:bg-zinc-700 text-zinc-300 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Next ›
        </button>
        {loading && <span className="text-xs text-zinc-500 ml-2">Loading…</span>}
      </div>

      {/* 4 KPI cards */}
      <div className="grid grid-cols-4 gap-4">
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
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="text-sm font-medium text-zinc-300">Daily Performance</div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500">Metric</span>
            <div className="flex rounded overflow-hidden border border-zinc-700">
              {KPI_OPTIONS.map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => setChartMetric(value)}
                  className={toggleBtn(chartMetric === value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" vertical={false} />
            <XAxis
              dataKey="day"
              tick={{ fill: "#a1a1aa", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tickFormatter={yAxisFmt}
              tick={{ fill: "#a1a1aa", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={60}
            />
            <Tooltip content={<ChartTooltip metric={chartMetric} />} />
            <Legend
              wrapperStyle={{ fontSize: 12, color: "#a1a1aa", paddingTop: 8 }}
              formatter={(value) => <span style={{ color: "#a1a1aa" }}>{value}</span>}
            />
            <Line
              type="monotone"
              dataKey="This Week"
              stroke="#f59e0b"
              strokeWidth={2}
              dot={{ r: 4, fill: "#f59e0b", strokeWidth: 0 }}
              activeDot={{ r: 5 }}
              connectNulls={false}
            />
            <Line
              type="monotone"
              dataKey="Prior Week"
              stroke="#60a5fa"
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={{ r: 3, fill: "#60a5fa", strokeWidth: 0 }}
              activeDot={{ r: 4 }}
              connectNulls={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Category breakdown */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-medium text-zinc-300">Category Breakdown</div>
        </div>

        {/* Day-of-week filter */}
        <div className="flex items-center gap-1.5 mb-4">
          <span className="text-xs text-zinc-600 mr-1">Day</span>
          <button
            onClick={() => setCatDayFilter(null)}
            className={`px-2.5 py-1 rounded text-xs font-medium border transition-colors ${
              catDayFilter === null
                ? "border-amber-600 bg-amber-900/20 text-amber-300"
                : "border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600"
            }`}
          >
            All
          </button>
          {dayPills.map(({ label, i, isFuture }) => (
            <button
              key={i}
              onClick={() => !isFuture && setCatDayFilter(i)}
              disabled={isFuture}
              className={`px-2.5 py-1 rounded text-xs font-medium border transition-colors disabled:opacity-25 disabled:cursor-not-allowed ${
                catDayFilter === i
                  ? "border-amber-600 bg-amber-900/20 text-amber-300"
                  : "border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600"
              }`}
            >
              {label}
            </button>
          ))}
          {catDayLoading && <span className="text-xs text-zinc-600 ml-1">Loading…</span>}
        </div>

        {!currentData && !loading && (
          <div className="text-sm text-zinc-600 italic">No data loaded.</div>
        )}

        {catSource && (
          <>
            <div className="flex items-center gap-4 mb-3 text-xs text-zinc-500">
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-3 h-0.5 bg-zinc-400 rounded" />
                Included in taproom net sales
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-3 h-0.5 bg-zinc-700 rounded" />
                Excluded
              </span>
            </div>

            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-zinc-500 uppercase border-b border-zinc-800">
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
                  const dim = cat.excluded ? "text-zinc-600" : "text-zinc-200";
                  const mono = `font-mono ${dim}`;
                  return (
                    <tr
                      key={cat.id}
                      className={`border-b ${cat.excluded ? "border-zinc-800/30" : "border-zinc-800/60"}`}
                    >
                      <td className={`py-2.5 font-medium ${dim}`}>
                        {cat.label}
                        {cat.excluded && (
                          <span className="ml-2 text-xs font-normal text-zinc-700 italic">excl.</span>
                        )}
                      </td>
                      <td className={`py-2.5 px-3 text-right ${mono}`}>
                        {cat.gross_sales_cents > 0 ? formatCurrency(cat.gross_sales_cents) : <span className="text-zinc-700">—</span>}
                      </td>
                      <td className={`py-2.5 px-3 text-right ${mono}`}>
                        {cat.discounts_cents > 0 ? <span className="text-red-400/70">({formatCurrency(cat.discounts_cents)})</span> : <span className="text-zinc-700">—</span>}
                      </td>
                      <td className={`py-2.5 px-3 text-right ${mono}`}>
                        {cat.returns_cents > 0 ? <span className="text-red-400/70">({formatCurrency(cat.returns_cents)})</span> : <span className="text-zinc-700">—</span>}
                      </td>
                      <td className={`py-2.5 px-3 text-right font-mono font-medium ${cat.excluded ? "text-zinc-600" : "text-zinc-100"}`}>
                        {cat.net_sales_cents > 0 ? formatCurrency(cat.net_sales_cents) : <span className="text-zinc-700">—</span>}
                      </td>
                      <td className={`py-2.5 pl-3 text-right ${mono}`}>
                        {cat.tax_cents > 0 ? formatCurrency(cat.tax_cents) : <span className="text-zinc-700">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {catNetTotal > 0 && (
                <tfoot>
                  <tr className="border-t border-zinc-700 text-zinc-200 font-semibold">
                    <td className="py-2">Total (included)</td>
                    <td className="py-2 px-3 text-right font-mono">{formatCurrency(catGrossTotal)}</td>
                    <td className="py-2 px-3 text-right font-mono text-red-400/70">
                      {catDiscTotal > 0 ? `(${formatCurrency(catDiscTotal)})` : "—"}
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-red-400/70">
                      {catRetTotal > 0 ? `(${formatCurrency(catRetTotal)})` : "—"}
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-zinc-100">{formatCurrency(catNetTotal)}</td>
                    <td className="py-2 pl-3 text-right font-mono">{formatCurrency(catTaxTotal)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </>
        )}
      </div>

    </div>
  );
}
