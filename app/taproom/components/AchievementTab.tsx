"use client";

import { useEffect, useState, useCallback } from "react";
import { formatCurrencyCents, formatPercent } from "@/lib/format";
import { todayLocalDate, addDaysStr, weekdayOf, dayStartUtc } from "@/lib/utils/datetime";
import { useBreweryTimezone } from "@/app/hooks/useBreweryTimezone";
import TimezoneLabel from "@/app/components/TimezoneLabel";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";
import { queryKeys } from "@/lib/query-keys";
import dynamic from "next/dynamic";
import ChartSkeleton from "@/app/components/ChartSkeleton";

const AchievementChart = dynamic(() => import("./AchievementChart"), {
  ssr: false,
  loading: () => <ChartSkeleton height={300} />,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Grain     = "monthly" | "weekly";
type Scope     = "quarter" | "year";
type ChartView = "per-period" | "cumulative";
type Tier      = "baseline" | "recovery" | "target" | "stretch";

type Target = { id: string; year: number; quarter: number; tier: Tier; target_cents: number };

type Period = {
  label: string; shortLabel: string;
  start: string; end: string;
  net_sales_cents: number | null; loading: boolean;
};

const TIERS: { value: Tier; label: string; color: string }[] = [
  { value: "baseline", label: "Baseline", color: "#71717a" },
  { value: "recovery", label: "Recovery", color: "#60a5fa" },
  { value: "target",   label: "Target",   color: "#f59e0b" },
  { value: "stretch",  label: "Stretch",  color: "#34d399" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currency(cents: number) {
  return formatCurrencyCents(cents, 0);
}
function pct(n: number, decimals = 1) { return formatPercent(n / 100, decimals); }

// All period math runs on YYYY-MM-DD calendar strings, never on the viewer's
// local `Date`, so the buckets (and which weekday a boundary lands on) are pinned
// to the brewery zone regardless of where the report is opened from. See
// `lib/utils/datetime.ts` for the shared BREWERY_TZ config + string helpers.

const MA = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MO = ["January","February","March","April","May","June","July","August","September","October","November","December"];

const pad = (n: number) => String(n).padStart(2, "0");
const isoDate = (year: number, month1: number, day: number) => `${year}-${pad(month1)}-${pad(day)}`;
// Last calendar day of a 1-based month. Magnitude only (via UTC) → zone-independent.
const daysInMonth = (year: number, month1: number) => new Date(Date.UTC(year, month1, 0)).getUTCDate();
// Split a YYYY-MM-DD into [year, month1, day].
const partsOf = (dateStr: string) => dateStr.split("-").map(Number) as [number, number, number];

function quarterDateRange(year: number, quarter: number) {
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth   = startMonth + 2;
  return { start: isoDate(year, startMonth, 1), end: isoDate(year, endMonth, daysInMonth(year, endMonth)) };
}

function buildMonthlyPeriods(year: number, quarter: number): Omit<Period,"net_sales_cents"|"loading">[] {
  const startMonth = (quarter - 1) * 3 + 1;
  return Array.from({ length: 3 }, (_, m) => {
    const month1 = startMonth + m;
    return { label: `${MO[month1 - 1]} ${year}`, shortLabel: MA[month1 - 1], start: isoDate(year, month1, 1), end: isoDate(year, month1, daysInMonth(year, month1)) };
  });
}

function buildWeeklyPeriods(year: number, quarter: number): Omit<Period,"net_sales_cents"|"loading">[] {
  const { start, end } = quarterDateRange(year, quarter);
  return buildWeekRange(start, end);
}

function buildYearlyMonthlyPeriods(year: number): Omit<Period,"net_sales_cents"|"loading">[] {
  return Array.from({ length: 12 }, (_, m) => {
    const month1 = m + 1;
    return { label: `${MO[m]} ${year}`, shortLabel: MA[m], start: isoDate(year, month1, 1), end: isoDate(year, month1, daysInMonth(year, month1)) };
  });
}

function buildYearlyWeeklyPeriods(year: number): Omit<Period,"net_sales_cents"|"loading">[] {
  return buildWeekRange(isoDate(year, 1, 1), isoDate(year, 12, 31));
}

// Snap a calendar date back to the Monday of its week.
function snapToMonday(dateStr: string): string {
  const day = weekdayOf(dateStr); // 0=Sun, 1=Mon ...
  const diff = day === 0 ? -6 : 1 - day;
  return addDaysStr(dateStr, diff);
}

function buildWeekRange(start: string, end: string): Omit<Period,"net_sales_cents"|"loading">[] {
  const out: Omit<Period,"net_sales_cents"|"loading">[] = [];
  let cur = snapToMonday(start);
  while (cur <= end) {
    const wkEnd = addDaysStr(cur, 6);
    // Clip both edges to the scope so the leading/trailing weeks don't spill
    // into the neighbouring quarter/year: without clipping the first week the
    // sales fetch (and "reached %") would count days before the scope start.
    // Middle weeks stay full Mon–Sun; iteration still advances by aligned weeks.
    const as    = cur   < start ? start : cur;
    const ae    = wkEnd > end   ? end   : wkEnd;
    const [, cm, cd] = partsOf(as);
    const [, am, ad] = partsOf(ae);
    const shortLabel = `${MA[cm - 1]} ${cd}`;
    const label = am === cm
      ? `${MA[cm - 1]} ${cd}–${ad}`
      : `${MA[cm - 1]} ${cd} – ${MA[am - 1]} ${ad}`;
    out.push({ label, shortLabel, start: as, end: ae });
    cur = addDaysStr(ae, 1);
  }
  return out;
}

const selectCls = "bg-surface-mid border border-line-subtle rounded px-1.5 py-1 sm:px-3 sm:py-2 text-xs sm:text-sm text-primary focus:outline-none focus:ring-2 focus:ring-accent";
const toggleBtn = (active: boolean) =>
  `px-2 py-1 sm:px-4 sm:py-2 text-xs sm:text-sm font-medium transition-colors ${active ? "bg-surface-high text-primary" : "bg-surface-mid text-secondary hover:text-strong"}`;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AchievementTab() {
  // "Today" and all period boundaries are computed in the taproom's configured
  // zone (Settings → Business), not the viewer's local zone — so they never drift
  // by a day when the report is opened from another timezone.
  const { timezone: tz } = useBreweryTimezone();
  const todayStr    = todayLocalDate(tz);
  const [ty, tm]    = todayStr.split("-").map(Number);
  const currentYear = ty;
  const currentQ    = Math.ceil(tm / 3) as 1|2|3|4;

  const [grain,      setGrain]      = useState<Grain>("weekly");
  const [scope,      setScope]      = useState<Scope>("quarter");
  const [year,       setYear]       = useState(currentYear);
  const [quarter,    setQuarter]    = useState<number>(currentQ);
  const [activeTier, setActiveTier] = useState<Tier>("target");
  const [chartView,  setChartView]  = useState<ChartView>("cumulative");
  const { data: targets = [] } = useQuery({
    queryKey: queryKeys.taproom.targets(),
    queryFn: () => fetchJson<Target[]>("/api/targets"),
  });
  const [periods,    setPeriods]    = useState<Period[]>([]);

  const loadPeriods = useCallback(async () => {
    const base =
      scope === "year"
        ? grain === "monthly" ? buildYearlyMonthlyPeriods(year) : buildYearlyWeeklyPeriods(year)
        : grain === "monthly" ? buildMonthlyPeriods(year, quarter) : buildWeeklyPeriods(year, quarter);

    const now   = todayStr;
    const live: Period[] = base.map((p) => ({ ...p, net_sales_cents: null, loading: p.start <= now }));
    setPeriods(live);

    const started = live.filter((p) => p.start <= now);
    const results = await Promise.allSettled(
      started.map((p) =>
        fetch(`/api/net-sales-summary?start=${p.start}&end=${p.end <= now ? p.end : now}`).then((r) => r.json())
      )
    );

    setPeriods((prev) =>
      prev.map((p) => {
        if (!p.loading) return { ...p, loading: false };
        const idx = started.findIndex((s) => s.start === p.start);
        const res = results[idx];
        return { ...p, loading: false, net_sales_cents: res?.status === "fulfilled" ? (res.value.net_sales_cents ?? null) : null };
      })
    );
  // tz: rebuild periods once the configured zone resolves (or if it changes), so
  // boundaries and the fetched date windows match the taproom's timezone.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grain, scope, year, quarter, tz]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- progressive parallel fetches require setState in callback
  useEffect(() => { loadPeriods(); }, [loadPeriods]);

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------

  // Target for this scope/tier
  const targetCents: number | null = (() => {
    if (scope === "quarter") {
      return targets.find((t) => t.year === year && t.quarter === quarter && t.tier === activeTier)?.target_cents ?? null;
    }
    // Year view: sum all 4 quarters if all are set
    const yt = targets.filter((t) => t.year === year && t.tier === activeTier);
    if (yt.length < 4) return null;
    return yt.reduce((s, t) => s + t.target_cents, 0);
  })();

  const quarterTiers = TIERS.filter((t) =>
    scope === "quarter"
      ? targets.some((x) => x.year === year && x.quarter === quarter && x.tier === t.value)
      : targets.filter((x) => x.year === year && x.tier === t.value).length === 4
  );

  const actualCents = periods.reduce((s, p) => s + (p.net_sales_cents ?? 0), 0);
  const gapCents    = targetCents !== null ? targetCents - actualCents : null;

  const now = todayStr;
  // Completed periods anchor the chart's dashed forecast at the last real point.
  const completedPeriods     = periods.filter((p) => p.end <= now && p.net_sales_cents !== null);
  const completedActualCents = completedPeriods.reduce((s, p) => s + (p.net_sales_cents ?? 0), 0);
  const lastCompletedIdx     = periods.reduce<number>((last, p, i) => (p.end <= now && p.net_sales_cents !== null ? i : last), -1);

  // Elapsed fraction of the scope, anchored to brewery-local day boundaries:
  // [00:00 of the first day, 00:00 of the day after the last day). "Now" is the
  // start of today in the brewery zone (day granularity is plenty here, and
  // deriving it from todayStr keeps this pure — no impure clock read during
  // render). Uses dayStartUtc (not the known-buggy dayEndUtc) so the window is exact.
  const rangeStartStr = scope === "year" ? isoDate(year, 1, 1)  : quarterDateRange(year, quarter).start;
  const rangeEndStr   = scope === "year" ? isoDate(year, 12, 31) : quarterDateRange(year, quarter).end;
  const startMs    = new Date(dayStartUtc(rangeStartStr, tz)).getTime();
  const endMs      = new Date(dayStartUtc(addDaysStr(rangeEndStr, 1), tz)).getTime();
  const nowMs      = new Date(dayStartUtc(todayStr, tz)).getTime();
  const totalMs    = endMs - startMs;
  const elapsedMs  = Math.min(Math.max(nowMs - startMs, 0), totalMs);
  const elapsedFrac = totalMs > 0 ? elapsedMs / totalMs : 0;

  // Whole-day counts + per-period day spans, for the day-based run rate. Handles
  // DST-length days via rounding. dailyRateDollars ($/day so far) drives both the
  // projection and the chart forecast, so the two never diverge in shape.
  const MS_PER_DAY = 86_400_000;
  const elapsedDays   = Math.round(elapsedMs / MS_PER_DAY);
  const periodDaysArr = periods.map((p) =>
    Math.round((new Date(dayStartUtc(addDaysStr(p.end, 1), tz)).getTime()
              - new Date(dayStartUtc(p.start, tz)).getTime()) / MS_PER_DAY));
  const dailyRateDollars = elapsedDays > 0 ? (actualCents / 100) / elapsedDays : 0;

  // ── Pace to date (the headline "are we on pace?" signal) ──────────────────
  // On pace = actual is at or above where we *should* be by today on a
  // straight-line path to the target: expected-to-date = target × elapsedFrac.
  // This is valid every day of the scope (that's the whole point), so it needs
  // no "wait until the quarter ends" gating.
  const expectedToDateCents = targetCents !== null ? Math.round(targetCents * elapsedFrac) : null;
  const paceDeltaCents      = expectedToDateCents !== null ? actualCents - expectedToDateCents : null;
  const onPace              = expectedToDateCents !== null ? actualCents >= expectedToDateCents : null;

  // Run-rate projection — extend today's daily sales rate across the whole scope
  // (actual ÷ fraction elapsed). Projecting by DAYS, not by whole-week slots,
  // avoids extrapolating a clipped 5-day edge week as if it were a full week, and
  // makes "projected ≥ target" the SAME condition as "on pace" (both reduce to
  // reached% ≥ elapsed%) — so the two cards can never contradict. Early on it
  // rests on very little data and swings hard, so below projectionMinElapsed it
  // is flagged low-confidence rather than shown as a firm red/green verdict.
  const projectionMinElapsed = 0.15;
  const projectionConfident  = elapsedFrac >= projectionMinElapsed;
  const projectedCents   = elapsedFrac > 0 && periods.length > 0
    ? Math.round(actualCents / elapsedFrac)
    : null;
  // Same inequality as onPace (actual/elapsedFrac ≥ target ⟺ actual ≥ target·elapsedFrac),
  // so bind it to onPace directly — recomputing from the rounded projectedCents could
  // flip at a sub-cent boundary and let the two cards contradict.
  const projectedOnTrack = projectedCents !== null ? onPace : null;

  const activeTierColor = TIERS.find((t) => t.value === activeTier)?.color ?? "#f59e0b";
  const tierLabel       = TIERS.find((t) => t.value === activeTier)?.label ?? "Target";

  // ---------------------------------------------------------------------------
  // Chart data
  // ---------------------------------------------------------------------------

  const chartData = periods.map((p, i) => {
    const isComplete       = p.end <= now;
    const isInProgress     = p.start <= now && !isComplete;
    const dollars          = p.net_sales_cents !== null ? p.net_sales_cents / 100 : null;
    // Cumulative sum of completed periods only (no partial weeks in the solid line)
    const cumCompletedDollars = periods.slice(0, i + 1).reduce(
      (s, x) => s + (x.end <= now && x.net_sales_cents !== null ? x.net_sales_cents / 100 : 0), 0
    );

    // Dashed forecast covers the in-progress week and all future weeks, at the
    // day-based run rate (rate × the period's own day-span), so a short edge week
    // forecasts less than a full one — consistent with the projection card.
    const forecastPerPeriod: number | undefined =
      !isComplete && dailyRateDollars > 0 ? Math.round(dailyRateDollars * periodDaysArr[i]) : undefined;

    let forecastCumulative: number | undefined;
    if (i === lastCompletedIdx && lastCompletedIdx >= 0) {
      forecastCumulative = Math.round(cumCompletedDollars);
    } else if (i > lastCompletedIdx && lastCompletedIdx >= 0 && dailyRateDollars > 0) {
      const forecastDays = periodDaysArr.slice(lastCompletedIdx + 1, i + 1).reduce((s, d) => s + d, 0);
      forecastCumulative = Math.round(completedActualCents / 100 + dailyRateDollars * forecastDays);
    }

    return {
      name:             p.shortLabel,
      // Solid lines: completed periods only
      "Net Sales":      isComplete && dollars !== null ? Math.round(dollars) : undefined,
      "Forecast":       forecastPerPeriod,
      "Cumulative":     isComplete ? Math.round(cumCompletedDollars) : undefined,
      "Forecast Total": forecastCumulative,
      _isInProgress:    isInProgress,
    };
  });

  // Reference lines (whole dollars)
  const perPeriodTargetDollars  = targetCents !== null && periods.length > 0 ? Math.round(targetCents / periods.length / 100) : null;
  const cumulativeTargetDollars = targetCents !== null ? Math.round(targetCents / 100) : null;

  // ---------------------------------------------------------------------------
  // Y-axis domain: ensure target reference lines are always visible
  // ---------------------------------------------------------------------------

  const maxPerPeriod = chartData.reduce((mx, d) => {
    return Math.max(mx, d["Net Sales"] ?? 0, d["Forecast"] ?? 0);
  }, perPeriodTargetDollars ?? 0);

  const maxCumulative = chartData.reduce((mx, d) => {
    return Math.max(mx, d["Cumulative"] ?? 0, d["Forecast Total"] ?? 0);
  }, cumulativeTargetDollars ?? 0);

  const yMax   = chartView === "per-period" ? maxPerPeriod : maxCumulative;
  const yDomain: [number, number] = [0, yMax > 0 ? Math.ceil(yMax * 1.12) : 1000];

  // ---------------------------------------------------------------------------
  // Table: expected pace per period
  // ---------------------------------------------------------------------------
  // Each period's expected share of the target = its share of the scope's
  // calendar days (same day-boundary basis as elapsedFrac), NOT a flat 1/N.
  // Only the ELAPSED slice of each period counts, clamped to the same "now"
  // boundary the pace bar uses — so a period whose last day is today is judged
  // against the days that have actually passed (not its full span), and the
  // per-period "vs. pace" can never disagree with the cumulative pace bar on a
  // period-boundary day. These slices sum to elapsedFrac, so the table and the
  // headline stay consistent every day of the scope.
  const expectedPctByStart = new Map<string, number>();
  for (const p of periods) {
    const pStartMs = new Date(dayStartUtc(p.start, tz)).getTime();
    const pEndMs   = new Date(dayStartUtc(addDaysStr(p.end, 1), tz)).getTime();
    const elapsedInPeriodMs = Math.min(Math.max(nowMs - pStartMs, 0), pEndMs - pStartMs);
    expectedPctByStart.set(p.start, totalMs > 0 ? (elapsedInPeriodMs / totalMs) * 100 : 0);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-6 max-w-5xl">

      {/* Controls — one row, no scroll */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex rounded overflow-hidden border border-line-strong">
          {(["quarter","year"] as Scope[]).map((s) => (
            <button key={s} onClick={() => setScope(s)} className={toggleBtn(scope === s)}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>

        <select value={year} onChange={(e) => setYear(Number(e.target.value))} className={selectCls}>
          {[currentYear - 2, currentYear - 1, currentYear, currentYear + 1].map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>

        {scope === "quarter" && (
          <select value={quarter} onChange={(e) => setQuarter(Number(e.target.value))} className={selectCls}>
            {[1,2,3,4].map((q) => <option key={q} value={q}>Q{q}</option>)}
          </select>
        )}

        <div className="flex rounded overflow-hidden border border-line-strong">
          {([["monthly","Mo"],["weekly","Wk"]] as const).map(([g, lbl]) => (
            <button key={g} onClick={() => setGrain(g as Grain)} className={toggleBtn(grain === g)}>
              <span className="sm:hidden">{lbl}</span>
              <span className="hidden sm:inline">{g.charAt(0).toUpperCase() + g.slice(1)}</span>
            </button>
          ))}
        </div>

        <TimezoneLabel className="w-full sm:w-auto sm:ml-auto" />
      </div>

      {/* Tier selector — label + 2×2 on mobile, single row on sm+ */}
      <div className="space-y-1.5 sm:space-y-0">
        <span className="text-xs text-muted">Compare vs.</span>
        <div className="grid grid-cols-2 gap-1.5 sm:flex sm:flex-wrap sm:gap-2 sm:items-center mt-1.5 sm:mt-0">
          {TIERS.map((t) => {
            const has = targets.some((x) =>
              scope === "quarter"
                ? x.year === year && x.quarter === quarter && x.tier === t.value
                : x.year === year && x.tier === t.value
            );
            return (
              <button key={t.value} onClick={() => setActiveTier(t.value)} disabled={!has}
                className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                  activeTier === t.value ? "border-current bg-surface-mid" : "border-line-strong text-secondary hover:border-line-subtle hover:text-strong"
                }`}
                style={activeTier === t.value ? { color: t.color, borderColor: t.color } : {}}>
                {t.label}
              </button>
            );
          })}
          {quarterTiers.length === 0 && (
            <span className="col-span-2 text-xs text-faint italic">
              {scope === "year" ? "Need all 4 quarters set for year total" : "No targets set for this quarter"}
            </span>
          )}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">

        <div className="bg-surface border border-line rounded-lg p-4">
          <div className="text-xs text-secondary mb-1">{scope === "year" ? "Annual" : "Quarterly"} Target</div>
          <div className="text-base sm:text-xl font-semibold text-primary">
            {targetCents !== null ? currency(targetCents) : <span className="text-muted text-sm sm:text-base">Not set</span>}
          </div>
          {scope === "year" && targetCents === null && targets.filter(t => t.year === year && t.tier === activeTier).length > 0 && (
            <div className="text-xs text-faint mt-0.5">
              {targets.filter(t => t.year === year && t.tier === activeTier).length}/4 quarters set
            </div>
          )}
        </div>

        <div className={`bg-surface border rounded-lg p-4 ${
          onPace === true ? "border-success-border" : onPace === false ? "border-danger-border" : "border-line"
        }`}>
          <div className="text-xs text-secondary mb-1">Actual Net Sales</div>
          <div className="text-xl font-semibold text-primary">{currency(actualCents)}</div>
          {targetCents !== null && (
            <div className="text-xs text-muted mt-0.5">{pct((actualCents / targetCents) * 100)} of target</div>
          )}
          {onPace !== null && paceDeltaCents !== null && (
            <div className={`text-xs mt-0.5 font-medium ${onPace ? "text-success" : "text-danger"}`}>
              {onPace
                ? `On pace · ${currency(paceDeltaCents)} ahead`
                : `Behind pace · ${currency(Math.abs(paceDeltaCents))} short`}
            </div>
          )}
        </div>

        {/* Run-rate forecast (year-end projection — distinct from pace to date).
            Firm red/green only once projectionConfident; before that it's neutral
            with a low-confidence note, since a few days of data swing wildly. */}
        <div className={`bg-surface border rounded-lg p-4 ${
          !projectionConfident ? "border-line"
          : projectedOnTrack === true ? "border-success-border"
          : projectedOnTrack === false ? "border-danger-border" : "border-line"
        }`}>
          <div className="text-xs text-secondary mb-1">Projected {scope === "year" ? "Full Year" : "Full Quarter"} · run rate</div>
          <div className={`text-base sm:text-xl font-semibold ${
            !projectionConfident ? "text-primary"
            : projectedOnTrack === true ? "text-success"
            : projectedOnTrack === false ? "text-danger" : "text-primary"
          }`}>
            {projectedCents !== null ? currency(projectedCents) : "—"}
          </div>
          {projectedOnTrack !== null && (
            projectionConfident ? (
              <div className={`text-xs mt-0.5 ${projectedOnTrack ? "text-success" : "text-danger"}`}>
                {projectedOnTrack
                  ? `Above target · +${currency(projectedCents! - targetCents!)}`
                  : `Below target by ${currency(Math.abs(projectedCents! - targetCents!))}`}
              </div>
            ) : (
              <div className="text-xs mt-0.5 text-muted">
                Trending {projectedOnTrack ? "above" : "below"} · low confidence, {pct(elapsedFrac * 100, 0)} elapsed
              </div>
            )
          )}
        </div>

        {/* Gap to target — raw remaining amount, not a pace verdict → neutral while short */}
        <div className={`bg-surface border rounded-lg p-4 ${
          gapCents !== null && gapCents <= 0 ? "border-success-border" : "border-line"
        }`}>
          <div className="text-xs text-secondary mb-1">Gap to {scope === "year" ? "Annual" : "Quarter"} Target</div>
          {gapCents === null ? (
            <div className="text-base sm:text-xl font-semibold text-muted">—</div>
          ) : gapCents <= 0 ? (
            <>
              <div className="text-base sm:text-xl font-semibold text-success">{currency(Math.abs(gapCents))} ahead</div>
              <div className="text-xs text-success mt-0.5">Target exceeded</div>
            </>
          ) : (
            <>
              <div className="text-base sm:text-xl font-semibold text-primary">{currency(gapCents)} to go</div>
              <div className="text-xs text-muted mt-0.5">vs. {tierLabel} goal</div>
            </>
          )}
        </div>

      </div>

      {/* Pace bar — reached (fill) vs. where you should be today (marker).
          On pace ⇔ fill reaches/passes the marker, so colour matches geometry. */}
      {targetCents !== null && (
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-secondary">Pace to date</span>
            {onPace !== null && paceDeltaCents !== null && (
              <span className={`text-xs font-medium ${onPace ? "text-success" : "text-danger"}`}>
                {onPace
                  ? `On pace · ${currency(paceDeltaCents)} ahead of target`
                  : `Behind pace · ${currency(Math.abs(paceDeltaCents))} short of target`}
              </span>
            )}
          </div>
          <div className="relative h-3 bg-surface-mid rounded-full overflow-hidden">
            {/* Where you should be today: target × elapsed */}
            <div className="absolute top-0 bottom-0 w-0.5 bg-line-subtle z-10"
              style={{ left: `${Math.min(elapsedFrac * 100, 100)}%` }} />
            {/* Where you actually are: reached */}
            <div className={`h-full rounded-full transition-all ${onPace ? "bg-success-emphasis" : "bg-danger-emphasis"}`}
              style={{ width: `${Math.min((actualCents / targetCents) * 100, 100)}%` }} />
          </div>
          <div className="flex justify-between text-xs text-muted">
            <span>{pct((actualCents / targetCents) * 100)} reached</span>
            {expectedToDateCents !== null && (
              <span>{pct(elapsedFrac * 100)} elapsed · {currency(expectedToDateCents)} expected by today</span>
            )}
          </div>
        </div>
      )}

      {/* How to read the two signals — documents the metric definitions in-UI */}
      {targetCents !== null && (
        <div className="rounded-lg border border-line bg-surface-mid/40 px-3 py-2.5 text-xs text-muted leading-relaxed">
          <span className="text-secondary font-medium">On pace</span> compares sales so far to the straight-line
          target for today — <span className="text-secondary">target × {pct(elapsedFrac * 100, 0)} elapsed</span>.{" "}
          <span className="text-secondary font-medium">Projected · run rate</span> extends your current daily sales
          rate across the whole {scope === "year" ? "year" : "quarter"}, so it&apos;s always on the same side of target
          as the pace bar. Early on it rests on only a few days of sales and swings a lot, so it stays a neutral
          &ldquo;low confidence&rdquo; estimate until {pct(projectionMinElapsed * 100, 0)} of the{" "}
          {scope === "year" ? "year" : "quarter"} has elapsed.
        </div>
      )}

      {/* Chart */}
      {periods.length > 0 && (
        <div className="bg-surface border border-line rounded-lg p-3 sm:p-5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
            <div className="text-sm font-medium text-body">
              {chartView === "per-period"
                ? `Net Sales per ${grain === "monthly" ? "Month" : "Week"}`
                : `Cumulative Net Sales`}
            </div>
            <div className="flex rounded overflow-hidden border border-line-strong self-start sm:self-auto">
              {([["per-period","Per Period"],["cumulative","Cumulative"]] as const).map(([v, lbl]) => (
                <button key={v} onClick={() => setChartView(v)}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                    chartView === v ? "bg-surface-high text-primary" : "bg-surface-mid text-secondary hover:text-strong"
                  }`}>
                  {lbl}
                </button>
              ))}
            </div>
          </div>

          <AchievementChart
            chartData={chartData}
            chartView={chartView}
            grain={grain}
            yDomain={yDomain}
            perPeriodTargetDollars={perPeriodTargetDollars}
            cumulativeTargetDollars={cumulativeTargetDollars}
            activeTierColor={activeTierColor}
            tierLabel={tierLabel}
          />
        </div>
      )}

      {/* Period table */}
      <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
      <table className="w-full text-sm border-collapse min-w-[460px]">
        <thead>
          <tr className="text-xs text-secondary uppercase border-b border-line">
            <th className="text-left py-2 pr-3 sm:pr-6">Period</th>
            <th className="text-right py-2 pr-3 sm:pr-6">Net Sales</th>
            {targetCents !== null && (
              <>
                <th className="text-right py-2 pr-2 sm:pr-4">% of Target</th>
                <th className="text-right py-2 whitespace-nowrap">vs. Pace</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {periods.map((p, i) => {
            const isFuture     = p.start > now;
            const isInProgress = p.start <= now && p.end > now;
            // For future periods, forecast at the day-based run rate × the period's
            // day-span (same basis as the chart forecast and projection card).
            const displayCents: number | null = isFuture
              ? (dailyRateDollars > 0 ? Math.round(dailyRateDollars * periodDaysArr[i] * 100) : null)
              : p.net_sales_cents;

            const actualPct = (targetCents !== null && displayCents !== null)
              ? (displayCents / targetCents) * 100 : null;
            const expectedPct = expectedPctByStart.get(p.start) ?? null;
            const variance  = (actualPct !== null && expectedPct !== null)
              ? actualPct - expectedPct : null;
            const ahead     = variance !== null && variance >= 0;

            return (
              <tr key={p.start} className={`border-b text-strong ${
                isFuture ? "border-line/20 opacity-60" : "border-line/40"
              }`}>
                <td className="py-2 pr-3 sm:pr-6">
                  <span className={isFuture ? "text-muted" : "text-body"}>
                    {p.label}
                  </span>
                  {isFuture && (
                    <span className="ml-1 text-xs text-faint italic">proj.</span>
                  )}
                  {isInProgress && (
                    <span className="ml-1 text-xs text-accent italic">in prog.</span>
                  )}
                </td>
                <td className="py-2 pr-3 sm:pr-6 text-right font-mono">
                  {p.loading ? (
                    <span className="text-muted">Loading…</span>
                  ) : isFuture ? (
                    displayCents !== null
                      ? <span className="text-muted italic">{currency(displayCents)}</span>
                      : <span className="text-disabled">—</span>
                  ) : isInProgress && p.net_sales_cents !== null ? (
                    <span className="text-secondary italic">{currency(p.net_sales_cents)}</span>
                  ) : p.net_sales_cents !== null ? (
                    currency(p.net_sales_cents)
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </td>
                {targetCents !== null && (
                  <>
                    <td className={`py-2 pr-2 sm:pr-4 text-right font-mono ${
                      isFuture || isInProgress ? "text-faint italic"
                      : actualPct === null ? "text-faint"
                      : ahead            ? "text-success"
                      : "text-danger"
                    }`}>
                      {actualPct !== null ? pct(actualPct) : "—"}
                    </td>
                    <td className={`py-2 text-right font-mono text-xs ${
                      isFuture || isInProgress ? "text-disabled"
                      : variance === null ? "text-faint"
                      : ahead             ? "text-success"
                      : "text-danger"
                    }`}>
                      {!isFuture && !isInProgress && variance !== null
                        ? `${variance >= 0 ? "+" : ""}${pct(variance)}`
                        : "—"}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
          {periods.length > 0 && (
            <tr className="text-primary font-medium border-t border-line-strong">
              <td className="py-2 pr-3 sm:pr-6">Total (actual)</td>
              <td className="py-2 pr-3 sm:pr-6 text-right font-mono">{currency(actualCents)}</td>
              {targetCents !== null && (
                <>
                  <td className={`py-2 pr-2 sm:pr-4 text-right font-mono ${
                    onPace === null ? "text-faint" : onPace ? "text-success" : "text-danger"
                  }`}>
                    {pct((actualCents / targetCents) * 100)}
                  </td>
                  <td className={`py-2 text-right font-mono text-xs ${
                    onPace === null ? "text-faint" : onPace ? "text-success" : "text-danger"
                  }`}>
                    {(() => {
                      // vs. straight-line pace: reached% minus elapsed% (where you should be today)
                      const v = ((actualCents / targetCents) * 100) - (elapsedFrac * 100);
                      return `${v >= 0 ? "+" : ""}${pct(v)}`;
                    })()}
                  </td>
                </>
              )}
            </tr>
          )}
        </tbody>
      </table>
      </div>
    </div>
  );
}
