"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import ChartSkeleton from "@/app/components/ChartSkeleton";
import ButtonGroup from "@/app/components/ButtonGroup";
import { fetchJson } from "../../production/hooks/queries";
import {
  buildTrend, combineOthers,
  type TrendData, type TrendGrouping, type TrendMode, type TrendRow,
} from "@/lib/reports/draftTrend";
import type { TrendSeries } from "./DraftTrendChart";

const DraftTrendChart = dynamic(() => import("./DraftTrendChart"), {
  ssr: false,
  loading: () => <ChartSkeleton height={300} />,
});

// Only the leaders get a line of their own; twenty near-identical hues can't be
// told apart. The rest fold into one grey line, and the beer filter isolates any.
const SERIES_COLORS = [
  "#f59e0b", "#60a5fa", "#34d399", "#f87171", "#a78bfa",
  "#fb923c", "#38bdf8", "#e879f9",
];
const OTHER_COLOR = "#71717a";

export type TrendRange = "30" | "90" | "all";

const GROUPINGS: { key: TrendGrouping; label: string }[] = [
  { key: "day",   label: "Day"   },
  { key: "week",  label: "Week"  },
  { key: "month", label: "Month" },
];
const RANGES: { key: TrendRange; label: string }[] = [
  { key: "30",  label: "30 days"  },
  { key: "90",  label: "90 days"  },
  { key: "all", label: "All time" },
];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Parsed at UTC noon so the viewer's zone can't shift a business date.
function bucketLabels(bucket: string, grouping: TrendGrouping): { top: string; main: string; axis: string } {
  const d = new Date(`${bucket}T12:00:00Z`);
  const md = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  if (grouping === "month") {
    const mon = MONTHS[d.getUTCMonth()];
    return { top: String(d.getUTCFullYear()), main: mon, axis: `${mon} ’${String(d.getUTCFullYear()).slice(2)}` };
  }
  if (grouping === "week") return { top: "Wk of", main: md, axis: md };
  return { top: WEEKDAYS[d.getUTCDay()], main: md, axis: md };
}

// Absent is "—"; a recorded zero (a keg with nothing unaccounted for) is a 0.
const num = (v: number | null | undefined) => (v == null ? "—" : Math.round(v).toLocaleString());

export interface TrendSummaryColumn {
  label: string;
  title?: string;
  value: (row: TrendRow) => string;
}

/**
 * One trend report: a beer filter, day/week/month grouping and a time range
 * over a line chart and the table behind it. Draft Stats uses it for both
 * sell-through (pours add up) and shrinkage (per-keg, so buckets average).
 */
export default function DraftTrendView({
  title, subtitle, endpoint, queryKey, mode, unit, chartTitle,
  defaultGrouping, defaultRange, summaryColumns, overallLabel, emptyText,
}: {
  title: string;
  subtitle: string;
  /** Returns TrendData for `?range=<days|all>`. */
  endpoint: string;
  queryKey: (range: TrendRange) => readonly unknown[];
  mode: TrendMode;
  unit: string;
  chartTitle: (grouping: TrendGrouping) => string;
  defaultGrouping: TrendGrouping;
  defaultRange: TrendRange;
  summaryColumns: TrendSummaryColumn[];
  overallLabel: string;
  emptyText: string;
}) {
  const [grouping, setGrouping] = useState<TrendGrouping>(defaultGrouping);
  const [range, setRange] = useState<TrendRange>(defaultRange);
  const [recipeFilter, setRecipeFilter] = useState("all");

  const { data, isPending, error } = useQuery({
    queryKey: queryKey(range),
    queryFn:  () => fetchJson<TrendData>(`${endpoint}?range=${range}`),
    staleTime: 5 * 60_000,
  });

  const trend = data ? buildTrend(data, grouping, mode) : null;
  const allRows = trend?.rows ?? [];
  // A beer picked under a longer range may have nothing in a shorter one.
  const selected = allRows.find((r) => r.recipe_id === recipeFilter) ?? null;
  const rows = selected ? [selected] : allRows;
  const beerOptions = [...allRows].sort((a, b) => a.beer_name.localeCompare(b.beer_name));

  // Chart: the selected beer alone, or the leaders plus one line for the rest.
  const leaders = selected ? [selected] : allRows.slice(0, SERIES_COLORS.length);
  const others = data && !selected
    ? combineOthers(data, new Set(leaders.map((r) => r.recipe_id)), grouping, mode)
    : null;
  const chartRows = others ? [...leaders, others] : leaders;
  const series: TrendSeries[] = chartRows.map((r, i) => ({
    key: r.recipe_id,
    label: r.beer_name,
    color: r === others ? OTHER_COLOR : SERIES_COLORS[i % SERIES_COLORS.length],
  }));
  const buckets = trend?.buckets ?? [];
  // Each line runs from the beer's first bucket to its last: before it was
  // tapped and after it came off, "no pours" is absence, not a zero.
  const spans = new Map(chartRows.map((r) => {
    const keys = Object.keys(r.by_bucket).sort();
    return [r.recipe_id, { first: keys[0], last: keys[keys.length - 1] }];
  }));
  const chartData = buckets.map((b) => {
    const row: Record<string, string | number | null> = { label: bucketLabels(b, grouping).axis };
    for (const r of chartRows) {
      const v = r.by_bucket[b];
      const span = spans.get(r.recipe_id)!;
      // Inside its run, a day with no pours is a real zero; a week with no keg
      // swapped is not — there is no shrinkage figure to plot.
      const gap = mode === "sum" && b > span.first && b < span.last ? 0 : null;
      row[r.recipe_id] = v != null ? Math.round(v) : gap;
    }
    return row;
  });

  // Table reads newest → oldest; the chart oldest → newest.
  const cols = [...buckets].reverse();

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-strong">{title}</h3>
          <p className="text-xs text-muted mt-0.5">{subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <select
            className="inp-sm w-52"
            aria-label="Filter to one beer"
            value={selected ? selected.recipe_id : "all"}
            onChange={(e) => setRecipeFilter(e.target.value)}
          >
            <option value="all">All beers</option>
            {beerOptions.map((r) => (
              <option key={r.recipe_id} value={r.recipe_id}>{r.beer_name}</option>
            ))}
          </select>
          <ButtonGroup tabs={GROUPINGS} activeKey={grouping} onSelect={setGrouping} />
          <ButtonGroup tabs={RANGES} activeKey={range} onSelect={setRange} />
        </div>
      </div>

      {error instanceof Error && <p className="text-sm text-danger mb-3">{error.message}</p>}

      {isPending ? (
        <p className="text-faint text-sm py-10 text-center">Loading…</p>
      ) : !trend || allRows.length === 0 ? (
        <p className="text-faint text-sm py-8 text-center">{emptyText}</p>
      ) : (
        <>
          <div className="rounded-lg border border-line bg-surface/30 p-4 mb-6">
            <h4 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
              {chartTitle(grouping)}
            </h4>
            <DraftTrendChart chartData={chartData} series={series} unit={unit} connectGaps={mode === "mean"} />
            <div className="flex flex-wrap gap-3 mt-2">
              {series.map((s) => (
                <span key={s.key} className="flex items-center gap-1.5 text-xs text-secondary">
                  <span className="w-2.5 h-0.5 inline-block" style={{ background: s.color }} />
                  {s.label}
                </span>
              ))}
            </div>
          </div>

          <div className="overflow-auto rounded-lg border border-line w-fit max-w-full">
            <table className="text-xs tabular-nums border-separate border-spacing-0">
              <thead>
                <tr>
                  <th className="sticky left-0 z-20 bg-surface px-3 py-2 text-left font-semibold text-secondary whitespace-nowrap border-b border-line">
                    Beer
                  </th>
                  {summaryColumns.map((c, i) => (
                    <th
                      key={c.label}
                      title={c.title}
                      className={`bg-surface px-3 py-2 text-right font-semibold text-secondary whitespace-nowrap border-b border-line ${
                        i === summaryColumns.length - 1 ? "border-r" : ""
                      }`}
                    >
                      {c.label}
                    </th>
                  ))}
                  {cols.map((b) => {
                    const h = bucketLabels(b, grouping);
                    return (
                      <th key={b} className="bg-surface px-2.5 py-2 text-right font-medium text-secondary whitespace-nowrap border-b border-line">
                        <span className="block text-faint">{h.top}</span>
                        {h.main}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.recipe_id}>
                    <td className="sticky left-0 z-10 bg-canvas px-3 py-2 font-medium text-strong whitespace-nowrap border-b border-line/40">
                      {r.beer_name}
                    </td>
                    {summaryColumns.map((c, i) => (
                      <td
                        key={c.label}
                        className={`px-3 py-2 text-right border-b border-line/40 ${
                          i === 0 ? "font-semibold text-strong" : "text-body"
                        } ${i === summaryColumns.length - 1 ? "border-r" : ""}`}
                      >
                        {c.value(r)}
                      </td>
                    ))}
                    {cols.map((b) => (
                      <td
                        key={b}
                        className={`px-2.5 py-2 text-right border-b border-line/40 ${r.by_bucket[b] != null ? "text-body" : "text-faint"}`}
                      >
                        {num(r.by_bucket[b])}
                      </td>
                    ))}
                  </tr>
                ))}
                {!selected && (
                  <tr>
                    <td className="sticky left-0 z-10 bg-surface px-3 py-2 font-semibold text-strong whitespace-nowrap">
                      {overallLabel}
                    </td>
                    {summaryColumns.map((c, i) => (
                      <td
                        key={c.label}
                        className={`bg-surface px-3 py-2 text-right font-semibold text-strong ${
                          i === summaryColumns.length - 1 ? "border-r border-line/40" : ""
                        }`}
                      >
                        {c.value(trend.overall)}
                      </td>
                    ))}
                    {cols.map((b) => (
                      <td key={b} className="bg-surface px-2.5 py-2 text-right font-semibold text-strong">
                        {num(trend.overall.by_bucket[b])}
                      </td>
                    ))}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
