"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { queryKeys, SALES_REPORT_STALE_TIME } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import { formatCurrencyCents } from "@/lib/format";
import { TAPROOM_MODEL_CATEGORIES } from "@/lib/constants/categories";
import {
  buildTrend, combineOthers, bucketOf, trendWindowQuery,
  type TrendData, type TrendGrouping, type TrendRow, type TrendWindow,
} from "@/lib/reports/draftTrend";
import { useBreweryTimezone } from "@/app/hooks/useBreweryTimezone";
import { todayLocalDate } from "@/lib/utils/datetime";
import TrendWindowPicker from "./TrendWindowPicker";
import type { ItemSalesData, ItemSalesItem } from "@/lib/reports/itemSales";
import type { TaproomLineContribution } from "@/types/reports";
import { applyControls } from "@/lib/table/applyControls";
import type { ControlsConfig } from "@/lib/table/types";
import ButtonGroup from "@/app/components/ButtonGroup";
import ChartSkeleton from "@/app/components/ChartSkeleton";
import FilterBar from "@/app/components/ui/FilterBar";
import SearchInput from "@/app/components/ui/SearchInput";
import FilterSelect from "@/app/components/ui/FilterSelect";
import type { TrendSeries } from "./DraftTrendChart";

const DraftTrendChart = dynamic(() => import("./DraftTrendChart"), {
  ssr: false,
  loading: () => <ChartSkeleton height={300} />,
});

// Per-item sell-through, built like Draft Stats' trend view: a line chart at
// day/week/month grain over a range, the table behind it, and — one level
// further than Draft Stats goes — the individual transactions behind any row.
// Answers "how is the rice cracker mix doing?" and "which kettle chip flavour
// sells?", which the category table on Sales Pulse stops short of.

type Metric = "units" | "net" | "floz";

const METRICS: { key: Metric; label: string }[] = [
  { key: "units", label: "Units"     },
  { key: "net",   label: "Net sales" },
  // Pour sizes roll up to the beer: a 5oz and a 16oz are one row, in ounces.
  // This is the view Draft Stats' Sell-through used to be.
  { key: "floz",  label: "Fl oz"     },
];
const GROUPINGS: { key: TrendGrouping; label: string }[] = [
  { key: "day",   label: "Day"   },
  { key: "week",  label: "Week"  },
  { key: "month", label: "Month" },
];
const RANGES: { key: string; label: string }[] = [
  { key: "30",  label: "30 days"  },
  { key: "90",  label: "90 days"  },
  { key: "180", label: "6 months" },
  { key: "365", label: "1 year"   },
];

const SERIES_COLORS = ["#f59e0b", "#60a5fa", "#34d399", "#f87171", "#a78bfa", "#fb923c", "#38bdf8", "#e879f9"];
const OTHER_COLOR = "#71717a";

// Search and category filter run through the shared table engine (the
// search/filter standard), held in local state rather than the URL because the
// chart and table both read them and a bookmark of a chart isn't a thing yet.
const ITEM_CONTROLS: ControlsConfig<ItemSalesItem> = {
  search: [{ param: "q", accessor: (i) => [i.itemName, i.variationName] }],
  filters: [{ param: "cat", accessor: (i) => i.categoryId }],
};

const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(TAPROOM_MODEL_CATEGORIES.map((c) => [c.id, c.label]));
const CATEGORY_OPTIONS = TAPROOM_MODEL_CATEGORIES.map((c) => ({ value: c.id, label: c.label }));

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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

function itemLabel(i: Pick<ItemSalesItem, "itemName" | "variationName">): string {
  return i.variationName ? `${i.itemName} · ${i.variationName}` : i.itemName;
}

function formatLineTime(iso: string): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ---------------------------------------------------------------------------
// Transaction drill — every line behind one item in the window.
// ---------------------------------------------------------------------------

function ItemDrill({ item, start, end, onClose }: { item: ItemSalesItem; start: string; end: string; onClose: () => void }) {
  const { data, isPending, error } = useQuery({
    queryKey: queryKeys.taproom.itemSalesLines(start, end, item.id),
    queryFn: () => fetchJson<{ lines: TaproomLineContribution[] }>(
      `/api/sales-pulse/items/lines?start=${start}&end=${end}&item=${encodeURIComponent(item.id)}`),
    staleTime: SALES_REPORT_STALE_TIME,
  });
  const lines = data?.lines ?? [];
  const net = (l: TaproomLineContribution) => l.grossSalesCents - l.discountsCents - l.returnsCents;
  const total = lines.reduce((s, l) => s + net(l), 0);
  const units = lines.reduce((s, l) => s + (l.kind === "return" ? -l.quantity : l.quantity), 0);

  return (
    <div className="rounded-lg border border-line bg-canvas mb-6">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-line/60">
        <div>
          <span className="text-sm font-semibold text-strong">{itemLabel(item)}</span>
          <span className="text-xs text-muted ml-2">transactions · {start} → {end}</span>
        </div>
        <button type="button" onClick={onClose} className="btn-secondary text-xs">Close</button>
      </div>

      {isPending && <div className="px-4 py-3 text-xs text-faint">Loading transactions…</div>}
      {error instanceof Error && <div className="px-4 py-3 text-xs text-danger">{error.message}</div>}
      {data && lines.length === 0 && <div className="px-4 py-3 text-xs text-faint italic">No transactions in this window.</div>}

      {lines.length > 0 && (
        <>
          <div className="overflow-auto max-h-96">
            <table className="w-full text-xs min-w-[520px]">
              <thead className="sticky top-0 bg-canvas">
                <tr className="text-2xs text-faint uppercase tracking-wider border-b border-line/60">
                  <th className="text-left px-4 py-1.5 font-medium">When</th>
                  <th className="text-right px-3 py-1.5 font-medium">Qty</th>
                  <th className="text-right px-3 py-1.5 font-medium">Gross</th>
                  <th className="text-right px-3 py-1.5 font-medium">Discount</th>
                  <th className="text-right px-3 py-1.5 font-medium">Net</th>
                  <th className="text-left px-3 py-1.5 font-medium">Order</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={`${l.orderId}:${l.lineUid}:${l.kind}`} className="border-b border-line/30">
                    <td className="px-4 py-1.5 text-muted whitespace-nowrap">
                      {formatLineTime(l.occurredAt)}
                      {l.kind === "return" && <span className="ml-2 text-2xs text-danger/70 uppercase tracking-wider">return</span>}
                      {l.prorated && <span className="ml-2 text-2xs text-muted italic">est.</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted">{l.kind === "return" ? -l.quantity : l.quantity}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted">{formatCurrencyCents(l.grossSalesCents, 2)}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted" title={l.discountNames.join(", ")}>
                      {l.discountsCents ? formatCurrencyCents(l.discountsCents, 2) : <span className="text-disabled">—</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-strong">{formatCurrencyCents(net(l), 2)}</td>
                    <td className="px-3 py-1.5 font-mono text-accent">{l.orderId.slice(-8)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between px-4 py-2 border-t border-line-strong text-xs font-semibold text-strong">
            <span>{lines.length} {lines.length === 1 ? "line" : "lines"} · {units} units</span>
            <span className="font-mono tabular-nums">{formatCurrencyCents(total, 2)}</span>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

const fmtUnits = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1));

export default function ItemsTab() {
  const { timezone } = useBreweryTimezone();
  const today = todayLocalDate(timezone);
  const [range, setRange] = useState<TrendWindow>("90");
  const [grouping, setGrouping] = useState<TrendGrouping>("week");
  const [metric, setMetric] = useState<Metric>("units");
  const [category, setCategory] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  // Rows the chart isolates (click to toggle); empty = leaders + Other.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [drill, setDrill] = useState<string | null>(null);

  const { data, isPending, error } = useQuery({
    queryKey: queryKeys.taproom.itemSales(range),
    queryFn: () => fetchJson<ItemSalesData>(`/api/sales-pulse/items?${trendWindowQuery(range)}`),
    staleTime: SALES_REPORT_STALE_TIME,
  });

  // Items matching the category + search; the chart and table see only these.
  const visibleItems = useMemo(
    () => applyControls(data?.items ?? [], ITEM_CONTROLS, { search: { q: search }, filters: { cat: category }, sort: null }),
    [data, category, search],
  );
  const variationById = useMemo(() => new Map(visibleItems.map((i) => [i.id, i])), [visibleItems]);

  // The rows the chart and table show. Units and dollars are per variation;
  // fl oz rolls every variation of an item into one row, since a 5oz and a
  // 16oz pour of the same beer are the same beer. Items whose size can't be
  // read are left out of that view rather than shown as zero.
  const rowItems: ItemSalesItem[] = useMemo(() => {
    if (metric !== "floz") return visibleItems;
    const groups = new Map<string, ItemSalesItem>();
    for (const i of visibleItems) {
      if (i.flOzPerUnit == null) continue;
      const id = `${i.categoryId}|${i.itemName}|*`;
      // The category rides in the variation slot so the chart legend can tell
      // the keg sales of a beer from its draft pours.
      if (!groups.has(id)) groups.set(id, { ...i, id, variationName: CATEGORY_LABEL[i.categoryId] ?? i.categoryId, flOzPerUnit: null });
    }
    return [...groups.values()];
  }, [visibleItems, metric]);
  const itemById = useMemo(() => new Map(rowItems.map((i) => [i.id, i])), [rowItems]);
  // Null = not a row: outside the category/search filter, or (fl oz) unsized.
  const rowIdFor = (variationId: string) => {
    const v = variationById.get(variationId);
    if (!v) return null;
    if (metric !== "floz") return variationId;
    return v.flOzPerUnit != null ? `${v.categoryId}|${v.itemName}|*` : null;
  };
  const unsizedCount = metric === "floz" ? visibleItems.filter((i) => i.flOzPerUnit == null).length : 0;

  // Feed the Draft Stats trend engine: an "event" is one item-day, valued by the metric.
  const trendData: TrendData | null = useMemo(() => {
    if (!data) return null;
    const events: TrendData["events"] = [];
    for (const e of data.events) {
      const id = rowIdFor(e.item_id);
      if (!id) continue;
      events.push({
        recipe_id: id, date: e.date,
        value: metric === "units" ? e.units : metric === "net" ? e.net_cents / 100 : e.fl_oz,
      });
    }
    return {
      start: data.start, end: data.end,
      recipes: rowItems.map((i) => ({ recipe_id: i.id, beer_name: itemLabel(i) })),
      events,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, rowItems, variationById, metric]);

  const trend = trendData ? buildTrend(trendData, grouping, "sum") : null;
  // Rank by total, not avg/event: a snack isn't "on tap" for a run of days.
  const allRows = useMemo(
    () => [...(trend?.rows ?? [])].sort((a, b) => b.sum - a.sum || a.beer_name.localeCompare(b.beer_name)),
    [trend],
  );
  const buckets = trend?.buckets ?? [];
  const bucketCount = Math.max(buckets.length, 1);

  const pickedRows = allRows.filter((r) => picked.has(r.recipe_id));
  const leaders = pickedRows.length > 0 ? pickedRows : allRows.slice(0, SERIES_COLORS.length);
  const others = trendData && pickedRows.length === 0
    ? combineOthers(trendData, new Set(leaders.map((r) => r.recipe_id)), grouping, "sum")
    : null;
  const chartRows = others ? [...leaders, others] : leaders;
  const series: TrendSeries[] = chartRows.map((r, i) => ({
    key: r.recipe_id,
    label: r === others ? r.beer_name.replace("beer", "item") : r.beer_name,
    color: r === others ? OTHER_COLOR : SERIES_COLORS[i % SERIES_COLORS.length],
  }));
  // A bucket with nothing sold is a real zero for a stocked item, so every
  // series is drawn across the whole window.
  const chartData = buckets.map((b) => {
    const row: Record<string, string | number | null> = { label: bucketLabels(b, grouping).axis };
    for (const r of chartRows) row[r.recipe_id] = Math.round(r.by_bucket[b] ?? 0);
    return row;
  });
  const unit = metric === "units" ? "units" : metric === "net" ? "$" : "fl oz";
  const fmt = (v: number) =>
    metric === "net" ? formatCurrencyCents(Math.round(v * 100), 0)
    : metric === "floz" ? `${Math.round(v).toLocaleString()} oz`
    : fmtUnits(v);

  function changeMetric(m: Metric) {
    if ((m === "floz") !== (metric === "floz")) { setPicked(new Set()); setDrill(null); }
    setMetric(m);
  }

  function togglePick(id: string) {
    setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  const drillItem = drill ? itemById.get(drill) ?? null : null;
  const cols = [...buckets].reverse();
  const thisBucket = data ? bucketOf(data.end, grouping) : "";

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <FilterBar>
          <SearchInput value={search} onChange={setSearch} placeholder="Search items…" />
          <FilterSelect label="Category" options={CATEGORY_OPTIONS} value={category} onChange={setCategory} />
        </FilterBar>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <ButtonGroup tabs={METRICS}   activeKey={metric}   onSelect={changeMetric} />
          <ButtonGroup tabs={GROUPINGS} activeKey={grouping} onSelect={setGrouping} />
          <TrendWindowPicker presets={RANGES} value={range} onChange={setRange} today={today} />
        </div>
      </div>

      {error instanceof Error && <p className="text-sm text-danger mb-3">{error.message}</p>}

      {isPending ? (
        <p className="text-faint text-sm py-10 text-center">Loading item sales…</p>
      ) : !trend || allRows.length === 0 ? (
        <p className="text-faint text-sm py-8 text-center">No items sold in this window.</p>
      ) : (
        <>
          <div className="rounded-lg border border-line bg-surface/30 p-4 mb-6">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-xs font-medium text-muted uppercase tracking-wide">
                {metric === "units" ? "Units sold" : metric === "net" ? "Net sales" : "Fl oz sold"} per {grouping}
              </h4>
              {pickedRows.length > 0 && (
                <button type="button" className="text-xs text-accent hover:underline" onClick={() => setPicked(new Set())}>
                  Show leaders
                </button>
              )}
            </div>
            <DraftTrendChart chartData={chartData} series={series} unit={unit} connectGaps={false} />
            <div className="flex flex-wrap gap-3 mt-2">
              {series.map((s) => (
                <span key={s.key} className="flex items-center gap-1.5 text-xs text-secondary">
                  <span className="w-2.5 h-0.5 inline-block" style={{ background: s.color }} />
                  {s.label}
                </span>
              ))}
            </div>
            <p className="text-2xs text-faint mt-2">
              Click a row to chart just that item (click more to compare). Double-click a row, or use Transactions, for the sales behind it.
              {unsizedCount > 0 && ` ${unsizedCount} ${unsizedCount === 1 ? "item has" : "items have"} no size in the name and ${unsizedCount === 1 ? "is" : "are"} left out of the fl oz view.`}
            </p>
          </div>

          {drillItem && data && (
            <ItemDrill item={drillItem} start={data.start} end={data.end} onClose={() => setDrill(null)} />
          )}

          <div className="overflow-auto rounded-lg border border-line w-fit max-w-full">
            <table className="text-xs tabular-nums border-separate border-spacing-0">
              <thead>
                <tr>
                  <th className="sticky left-0 z-20 bg-surface px-3 py-2 text-left font-semibold text-secondary whitespace-nowrap border-b border-line">
                    Item
                  </th>
                  <th className="bg-surface px-3 py-2 text-left font-semibold text-secondary whitespace-nowrap border-b border-line">Category</th>
                  <th className="bg-surface px-3 py-2 text-right font-semibold text-secondary whitespace-nowrap border-b border-line">Total</th>
                  <th className="bg-surface px-3 py-2 text-right font-semibold text-secondary whitespace-nowrap border-b border-line border-r" title={`Average per ${grouping} over the window`}>
                    Avg / {grouping}
                  </th>
                  <th className="bg-surface px-2 py-2 border-b border-line border-r" />
                  {cols.map((b) => {
                    const h = bucketLabels(b, grouping);
                    return (
                      <th key={b} className="bg-surface px-2.5 py-2 text-right font-medium text-secondary whitespace-nowrap border-b border-line">
                        <span className="block text-faint">{b === thisBucket && bucketOf(data!.end, grouping) !== data!.end ? (data!.end === today ? "so far" : "partial") : h.top}</span>
                        {h.main}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {allRows.map((r: TrendRow) => {
                  const item = itemById.get(r.recipe_id);
                  const isPicked = picked.has(r.recipe_id);
                  return (
                    <tr
                      key={r.recipe_id}
                      onClick={() => togglePick(r.recipe_id)}
                      onDoubleClick={() => setDrill(r.recipe_id)}
                      className={`cursor-pointer select-none ${isPicked ? "bg-accent-muted/20" : "hover:bg-surface-mid/40"}`}
                    >
                      <td className={`sticky left-0 z-10 px-3 py-2 font-medium text-strong whitespace-nowrap border-b border-line/40 ${isPicked ? "bg-accent-muted/20" : "bg-canvas"}`}>
                        {item?.itemName ?? r.beer_name}
                        {item?.variationName && <span className="text-faint ml-1.5 font-normal">{item.variationName}</span>}
                      </td>
                      <td className="px-3 py-2 text-muted whitespace-nowrap border-b border-line/40">
                        {item ? CATEGORY_LABEL[item.categoryId] ?? item.categoryId : "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-semibold text-strong border-b border-line/40">{fmt(r.sum)}</td>
                      <td className="px-3 py-2 text-right text-body border-b border-line/40 border-r">{fmt(r.sum / bucketCount)}</td>
                      <td className="px-2 py-2 border-b border-line/40 border-r">
                        <button
                          type="button"
                          className="text-2xs text-accent hover:underline whitespace-nowrap"
                          onClick={(e) => { e.stopPropagation(); setDrill(r.recipe_id); }}
                        >
                          Transactions
                        </button>
                      </td>
                      {cols.map((b) => (
                        <td key={b} className={`px-2.5 py-2 text-right border-b border-line/40 ${r.by_bucket[b] != null ? "text-body" : "text-faint"}`}>
                          {r.by_bucket[b] != null ? fmt(r.by_bucket[b]) : "—"}
                        </td>
                      ))}
                    </tr>
                  );
                })}
                <tr>
                  <td className="sticky left-0 z-10 bg-surface px-3 py-2 font-semibold text-strong whitespace-nowrap">
                    All shown ({allRows.length})
                  </td>
                  <td className="bg-surface" />
                  <td className="bg-surface px-3 py-2 text-right font-semibold text-strong">{fmt(trend.overall.sum)}</td>
                  <td className="bg-surface px-3 py-2 text-right font-semibold text-strong border-r border-line/40">{fmt(trend.overall.sum / bucketCount)}</td>
                  <td className="bg-surface border-r border-line/40" />
                  {cols.map((b) => (
                    <td key={b} className="bg-surface px-2.5 py-2 text-right font-semibold text-strong">
                      {trend.overall.by_bucket[b] != null ? fmt(trend.overall.by_bucket[b]) : "—"}
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
