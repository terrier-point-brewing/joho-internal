"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import ChartSkeleton from "@/app/components/ChartSkeleton";
import ButtonGroup from "@/app/components/ButtonGroup";
import { CellLabel } from "@/app/components/ui/Table";
import TrendTable, { type TrendTableSummary } from "./TrendTable";
import { fetchJson } from "../../production/hooks/queries";
import {
  buildTrend, combineOthers, trendWindowQuery,
  type TrendData, type TrendGrouping, type TrendMode, type TrendWindow,
} from "@/lib/reports/draftTrend";
import { useBreweryTimezone } from "@/app/hooks/useBreweryTimezone";
import { todayLocalDate } from "@/lib/utils/datetime";
import type { TrendSeries } from "./DraftTrendChart";
import TrendWindowPicker from "./TrendWindowPicker";
import TrendLineDrill from "./TrendLineDrill";

const DraftTrendChart = dynamic(() => import("./DraftTrendChart"), {
  ssr: false,
  loading: () => <ChartSkeleton />,
});

// Only the leaders get a line of their own; twenty near-identical hues can't be
// told apart. The rest fold into one grey line, and the beer filter isolates any.
const SERIES_COLORS = [
  "#f59e0b", "#60a5fa", "#34d399", "#f87171", "#a78bfa",
  "#fb923c", "#38bdf8", "#e879f9",
];
const OTHER_COLOR = "#71717a";

/** Preset keys; a custom `YYYY-MM-DD..YYYY-MM-DD` is also a valid window. */
export type TrendRange = TrendWindow;

const GROUPINGS: { key: TrendGrouping; label: string }[] = [
  { key: "day",   label: "Day"   },
  { key: "week",  label: "Week"  },
  { key: "month", label: "Month" },
];
const RANGES: { key: string; label: string }[] = [
  { key: "30",  label: "30 days"  },
  { key: "90",  label: "90 days"  },
  { key: "365", label: "1 year"   },
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

/** Where a row's individual records come from, for the transaction drill. */
export interface TrendLinesSource {
  /** Gets `?start&end&recipe=` appended; returns `{ lines: TrendLine[] }`. */
  endpoint: string;
  queryKey: (start: string, end: string, recipe: string) => readonly unknown[];
  quantityLabel?: string;
  valueLabel: string;
  formatValue: (v: number) => string;
}

export type TrendSummaryColumn = TrendTableSummary;

/**
 * One trend report: a beer filter, day/week/month grouping and a time range
 * over a line chart and the table behind it. Draft Stats uses it for both
 * sell-through (pours add up) and shrinkage (per-keg, so buckets average).
 */
export default function DraftTrendView({
  title, subtitle, endpoint, queryKey, mode, unit, chartTitle,
  defaultGrouping, defaultRange, summaryColumns, overallLabel, emptyText, lines,
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
  /** When given, every row can open the records behind it. */
  lines?: TrendLinesSource;
}) {
  const { timezone } = useBreweryTimezone();
  const today = todayLocalDate(timezone);
  const [grouping, setGrouping] = useState<TrendGrouping>(defaultGrouping);
  const [range, setRange] = useState<TrendRange>(defaultRange);
  const [recipeFilter, setRecipeFilter] = useState("all");
  const [drill, setDrill] = useState<string | null>(null);

  const { data, isPending, error } = useQuery({
    queryKey: queryKey(range),
    queryFn:  () => fetchJson<TrendData>(`${endpoint}?${trendWindowQuery(range)}`),
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
  const drillRow = drill ? allRows.find((r) => r.recipe_id === drill) ?? null : null;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-strong">{title}</h3>
          <p className="text-xs text-muted mt-0.5">{subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 desk:gap-x-4 max-sm:w-full">
          <select
            className="inp-sm max-sm:flex-1 max-sm:min-w-0 sm:w-52"
            aria-label="Filter to one beer"
            value={selected ? selected.recipe_id : "all"}
            onChange={(e) => setRecipeFilter(e.target.value)}
          >
            <option value="all">All beers</option>
            {beerOptions.map((r) => (
              <option key={r.recipe_id} value={r.recipe_id}>{r.beer_name}</option>
            ))}
          </select>
          <ButtonGroup label="Grouping" collapse tabs={GROUPINGS} activeKey={grouping} onSelect={setGrouping} />
          <TrendWindowPicker presets={RANGES} value={range} onChange={setRange} today={today} />
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
            <div className="chart-box">
              <DraftTrendChart chartData={chartData} series={series} unit={unit} connectGaps={mode === "mean"} />
            </div>
            <div className="scroll-x flex sm:flex-wrap gap-3 mt-2">
              {series.map((s) => (
                <span key={s.key} className="flex shrink-0 items-center gap-1.5 text-xs text-secondary whitespace-nowrap">
                  <span className="w-2.5 h-0.5 inline-block" style={{ background: s.color }} />
                  {s.label}
                </span>
              ))}
            </div>
          </div>

          {lines && drillRow && (
            <TrendLineDrill
              title={drillRow.beer_name}
              start={data!.start}
              end={data!.end}
              url={`${lines.endpoint}?start=${data!.start}&end=${data!.end}&recipe=${encodeURIComponent(drillRow.recipe_id)}`}
              queryKey={lines.queryKey(data!.start, data!.end, drillRow.recipe_id)}
              quantityLabel={lines.quantityLabel}
              valueLabel={lines.valueLabel}
              formatValue={lines.formatValue}
              onClose={() => setDrill(null)}
            />
          )}

          {lines && (
            <p className="text-2xs text-faint mb-2">
              Select a row to chart just that beer.
              <span className="md:hidden"> Its first figure opens the records behind it.</span>
              <span className="max-md:hidden"> Details opens the records behind it.</span>
            </p>
          )}

          <TrendTable
            labelHeader="Beer"
            rows={rows}
            overall={selected ? null : { label: overallLabel, row: trend.overall }}
            buckets={cols}
            bucketHeader={(b) => bucketLabels(b, grouping)}
            summary={summaryColumns}
            cell={num}
            renderLabel={(r) => <CellLabel>{r.beer_name}</CellLabel>}
            onRowClick={(r) => setRecipeFilter(selected ? "all" : r.recipe_id)}
            details={lines ? { label: "Details", onOpen: (r) => setDrill(r.recipe_id) } : undefined}
          />
        </>
      )}
    </div>
  );
}
