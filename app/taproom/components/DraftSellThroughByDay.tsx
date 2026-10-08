"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "../../production/hooks/queries";
import dynamic from "next/dynamic";
import ChartSkeleton from "@/app/components/ChartSkeleton";
import ButtonGroup from "@/app/components/ButtonGroup";
import type { SellThroughSeries } from "./DraftSellThroughChart";
import type { DraftPoursByDay } from "@/lib/reports/draftPoursByDay";

const DraftSellThroughChart = dynamic(() => import("./DraftSellThroughChart"), {
  ssr: false,
  loading: () => <ChartSkeleton height={260} />,
});

// Same palette as the shrinkage chart. Only the top sellers get a colour of
// their own; a stack of twenty near-identical hues can't be read.
const SERIES_COLORS = [
  "#f59e0b", "#60a5fa", "#34d399", "#f87171", "#a78bfa",
  "#fb923c", "#38bdf8", "#4ade80",
];
const OTHER_KEY = "other";
const OTHER_COLOR = "#71717a";

type RangeKey = "7" | "14" | "30";

const RANGES: { key: RangeKey; label: string }[] = [
  { key: "7",  label: "7 days"  },
  { key: "14", label: "14 days" },
  { key: "30", label: "30 days" },
];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Parsed at UTC noon so the viewer's zone can't shift a business date.
function dayHeader(date: string) {
  const d = new Date(`${date}T12:00:00Z`);
  return { weekday: WEEKDAYS[d.getUTCDay()], md: `${d.getUTCMonth() + 1}/${d.getUTCDate()}` };
}

const oz = (v: number | undefined) => (v ? Math.round(v).toLocaleString() : "—");

/** Fl oz poured per beer per business day — newest day first. */
export default function DraftSellThroughByDay() {
  const [range, setRange] = useState<RangeKey>("14");
  const days = Number(range);

  const { data, isPending, error } = useQuery({
    queryKey: queryKeys.taproom.draftPours(days),
    queryFn:  () => fetchJson<DraftPoursByDay>(`/api/taproom/draft-pours?days=${days}`),
    staleTime: 5 * 60_000,
  });

  const dayCols = data ? [...data.days].reverse() : [];

  // Chart reads oldest → newest, the table newest → oldest.
  const recipes = data?.recipes ?? [];
  const topRecipes = recipes.slice(0, SERIES_COLORS.length);
  const otherRecipes = recipes.slice(SERIES_COLORS.length);
  const series: SellThroughSeries[] = [
    ...topRecipes.map((r, i) => ({ key: r.recipe_id, label: r.beer_name, color: SERIES_COLORS[i] })),
    ...(otherRecipes.length > 0
      ? [{ key: OTHER_KEY, label: `Other (${otherRecipes.length} beers)`, color: OTHER_COLOR }]
      : []),
  ];
  const chartData = (data?.days ?? []).map((d) => {
    const h = dayHeader(d);
    const row: Record<string, string | number> = { label: `${h.weekday} ${h.md}` };
    for (const r of topRecipes) row[r.recipe_id] = Math.round(r.by_day[d] ?? 0);
    if (otherRecipes.length > 0) {
      row[OTHER_KEY] = Math.round(otherRecipes.reduce((sum, r) => sum + (r.by_day[d] ?? 0), 0));
    }
    return row;
  });

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-strong">Sell-through by day</h3>
          <p className="text-xs text-muted mt-0.5">
            fl oz poured per beer, from Square pour sales
          </p>
        </div>
        <ButtonGroup tabs={RANGES} activeKey={range} onSelect={setRange} />
      </div>

      {error instanceof Error && <p className="text-sm text-danger mb-3">{error.message}</p>}

      {isPending ? (
        <p className="text-faint text-sm py-10 text-center">Loading pours…</p>
      ) : !data || data.recipes.length === 0 ? (
        <p className="text-faint text-sm py-8 text-center">No draft pours recorded in the last {days} days.</p>
      ) : (
        <>
        <div className="rounded-lg border border-line bg-surface/30 p-4 mb-6">
          <h4 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
            Pours per day (fl oz)
          </h4>
          <DraftSellThroughChart chartData={chartData} series={series} />
          <div className="flex flex-wrap gap-3 mt-2">
            {series.map((s) => (
              <span key={s.key} className="flex items-center gap-1.5 text-xs text-secondary">
                <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: s.color }} />
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
                <th className="bg-surface px-3 py-2 text-right font-semibold text-secondary whitespace-nowrap border-b border-line">
                  Total
                </th>
                <th
                  className="bg-surface px-3 py-2 text-right font-semibold text-secondary whitespace-nowrap border-b border-r border-line"
                  title="Average over the days this beer poured"
                >
                  Avg / day
                </th>
                {dayCols.map((d) => {
                  const h = dayHeader(d);
                  return (
                    <th key={d} className="bg-surface px-2.5 py-2 text-right font-medium text-secondary whitespace-nowrap border-b border-line">
                      <span className="block text-faint">{h.weekday}</span>
                      {h.md}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {data.recipes.map((r) => (
                <tr key={r.recipe_id}>
                  <td className="sticky left-0 z-10 bg-canvas px-3 py-2 font-medium text-strong whitespace-nowrap border-b border-line/40">
                    {r.beer_name}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-strong border-b border-line/40">
                    {oz(r.total_fl_oz)}
                  </td>
                  <td className="px-3 py-2 text-right text-body border-b border-r border-line/40">
                    {oz(r.avg_fl_oz_per_day)}
                  </td>
                  {dayCols.map((d) => (
                    <td
                      key={d}
                      className={`px-2.5 py-2 text-right border-b border-line/40 ${r.by_day[d] ? "text-body" : "text-faint"}`}
                    >
                      {oz(r.by_day[d])}
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <td className="sticky left-0 z-10 bg-surface px-3 py-2 font-semibold text-strong whitespace-nowrap">
                  All draft
                </td>
                <td className="bg-surface px-3 py-2 text-right font-semibold text-strong">
                  {oz(data.total_fl_oz)}
                </td>
                <td className="bg-surface px-3 py-2 border-r border-line/40" />
                {dayCols.map((d) => (
                  <td key={d} className="bg-surface px-2.5 py-2 text-right font-semibold text-strong">
                    {oz(data.totals_by_day[d])}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        </>
      )}
    </div>
  );
}
