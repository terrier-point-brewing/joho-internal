import { addDaysStr, mondayOf } from "@/lib/utils/datetime";

/**
 * Shared shape behind the Draft Stats trend views (sell-through, shrinkage):
 * dated per-beer events over a window, bucketed by day, week or month.
 */
export type TrendGrouping = "day" | "week" | "month";

/** How a bucket combines its events: pours add up, shrinkage is per-keg so it averages. */
export type TrendMode = "sum" | "mean";

export interface TrendEvent {
  recipe_id: string;
  /** Business date, YYYY-MM-DD. */
  date: string;
  value: number;
  /** Optional companion figure, always averaged (shrinkage's % of keg). */
  aux?: number;
}

export interface TrendData {
  /** Window bounds, inclusive. For "all time" `start` is the first event's date. */
  start: string;
  end: string;
  recipes: { recipe_id: string; beer_name: string }[];
  events: TrendEvent[];
}

export interface TrendRow {
  recipe_id: string;
  beer_name: string;
  /** Bucket start date → combined value. A bucket with no events is absent. */
  by_bucket: Record<string, number>;
  sum: number;
  count: number;
  mean: number;
  aux_mean: number | null;
}

export interface Trend {
  /** Every bucket start date in the window, oldest first — including empty ones. */
  buckets: string[];
  /** One row per beer with events, ranked by volume (sum) or by event count (mean). */
  rows: TrendRow[];
  /** Every event in the window combined, as one row. */
  overall: TrendRow;
}

/** Start date of the bucket holding `date`: the day, its Monday, or the 1st. */
export function bucketOf(date: string, grouping: TrendGrouping): string {
  if (grouping === "week") return mondayOf(date);
  if (grouping === "month") return `${date.slice(0, 7)}-01`;
  return date;
}

function nextBucket(bucket: string, grouping: TrendGrouping): string {
  if (grouping === "day") return addDaysStr(bucket, 1);
  if (grouping === "week") return addDaysStr(bucket, 7);
  const [y, m] = bucket.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

export function bucketsBetween(start: string, end: string, grouping: TrendGrouping): string[] {
  const out: string[] = [];
  if (start > end) return out;
  const last = bucketOf(end, grouping);
  for (let b = bucketOf(start, grouping); b <= last; b = nextBucket(b, grouping)) out.push(b);
  return out;
}

function combine(
  id: string, name: string, events: TrendEvent[], grouping: TrendGrouping, mode: TrendMode,
): TrendRow {
  const acc = new Map<string, { sum: number; n: number }>();
  let sum = 0;
  let auxSum = 0;
  let auxN = 0;
  for (const e of events) {
    const b = bucketOf(e.date, grouping);
    const cur = acc.get(b) ?? { sum: 0, n: 0 };
    cur.sum += e.value;
    cur.n += 1;
    acc.set(b, cur);
    sum += e.value;
    if (e.aux != null) { auxSum += e.aux; auxN += 1; }
  }
  const byBucket: Record<string, number> = {};
  for (const [b, v] of acc) byBucket[b] = mode === "sum" ? v.sum : v.sum / v.n;
  return {
    recipe_id: id,
    beer_name: name,
    by_bucket: byBucket,
    sum,
    count: events.length,
    mean: events.length > 0 ? sum / events.length : 0,
    aux_mean: auxN > 0 ? auxSum / auxN : null,
  };
}

/** Bucket a window of events into per-beer rows plus one all-beers row. */
export function buildTrend(data: TrendData, grouping: TrendGrouping, mode: TrendMode): Trend {
  const nameById = new Map(data.recipes.map((r) => [r.recipe_id, r.beer_name]));
  const byRecipe = new Map<string, TrendEvent[]>();
  const inWindow: TrendEvent[] = [];
  for (const e of data.events) {
    if (e.date < data.start || e.date > data.end) continue;
    inWindow.push(e);
    const list = byRecipe.get(e.recipe_id) ?? [];
    list.push(e);
    byRecipe.set(e.recipe_id, list);
  }

  const rank = (r: TrendRow) => (mode === "sum" ? r.sum : r.count);
  const rows = [...byRecipe.entries()]
    .map(([id, events]) => combine(id, nameById.get(id) ?? "—", events, grouping, mode))
    .sort((a, b) => rank(b) - rank(a) || a.beer_name.localeCompare(b.beer_name));

  return {
    buckets: bucketsBetween(data.start, data.end, grouping),
    rows,
    overall: combine("all", "All beers", inWindow, grouping, mode),
  };
}

/**
 * Collapse every beer outside `keepIds` into one row, so a chart can draw the
 * leaders individually and the long tail as a single line.
 */
export function combineOthers(
  data: TrendData, keepIds: Set<string>, grouping: TrendGrouping, mode: TrendMode,
): TrendRow | null {
  const events = data.events.filter(
    (e) => !keepIds.has(e.recipe_id) && e.date >= data.start && e.date <= data.end,
  );
  if (events.length === 0) return null;
  const beers = new Set(events.map((e) => e.recipe_id)).size;
  return combine("other", `Other (${beers} beer${beers === 1 ? "" : "s"})`, events, grouping, mode);
}

/** Parse the routes' `range` param: a day count, or "all". Anything else → fallback. */
export function parseTrendRange(raw: string | null, fallbackDays: number): number | "all" {
  if (raw === "all") return "all";
  const n = parseInt(raw ?? "");
  return Number.isFinite(n) && n > 0 ? Math.min(n, 3650) : fallbackDays;
}
