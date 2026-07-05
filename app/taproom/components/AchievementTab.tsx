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
    const ae    = wkEnd > end ? end : wkEnd;
    const [, cm, cd] = partsOf(cur);
    const [, am, ad] = partsOf(ae);
    const shortLabel = `${MA[cm - 1]} ${cd}`;
    const label = am === cm
      ? `${MA[cm - 1]} ${cd}–${ad}`
      : `${MA[cm - 1]} ${cd} – ${MA[am - 1]} ${ad}`;
    out.push({ label, shortLabel, start: cur, end: ae });
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
  // Only fully-elapsed periods count toward the actuals average; the current in-progress
  // week is partial data and would pull the average down if included.
  const completedPeriods    = periods.filter((p) => p.end <= now && p.net_sales_cents !== null);
  const completedActualCents = completedPeriods.reduce((s, p) => s + (p.net_sales_cents ?? 0), 0);
  const avgDollarsPerPeriod = completedPeriods.length > 0 ? (completedActualCents / completedPeriods.length) / 100 : 0;
  const lastCompletedIdx    = periods.reduce<number>((last, p, i) => (p.end <= now && p.net_sales_cents !== null ? i : last), -1);

  // Pace / projection — project the run rate of completed periods across the full scope,
  // the same basis as the chart's dashed "Forecast Total" line (avg completed period ×
  // number of periods). The in-progress partial period is excluded so it doesn't distort
  // the rate. A pure wall-clock extrapolation (actual ÷ fraction-of-time-elapsed) diverges
  // sharply from this early in a quarter and over-projects, so it is intentionally not used.
  const rangeStartStr = scope === "year" ? isoDate(year, 1, 1)  : quarterDateRange(year, quarter).start;
  const rangeEndStr   = scope === "year" ? isoDate(year, 12, 31) : quarterDateRange(year, quarter).end;
  // Anchor the elapsed fraction to brewery-local day boundaries: [00:00 of the
  // first day, 00:00 of the day after the last day). "Now" is the start of today
  // in the brewery zone (day granularity is plenty for the pace bar, and keeping
  // it derived from todayStr keeps this pure — no impure clock read during render).
  // Uses dayStartUtc (not the known-buggy dayEndUtc) so the window is exact.
  const startMs    = new Date(dayStartUtc(rangeStartStr, tz)).getTime();
  const endMs      = new Date(dayStartUtc(addDaysStr(rangeEndStr, 1), tz)).getTime();
  const nowMs      = new Date(dayStartUtc(todayStr, tz)).getTime();
  const totalMs    = endMs - startMs;
  const elapsedMs  = Math.min(Math.max(nowMs - startMs, 0), totalMs);
  const elapsedFrac = totalMs > 0 ? elapsedMs / totalMs : 0; // used by the pace bar only
  const projectedCents = completedPeriods.length > 0 && periods.length > 0
    ? Math.round(avgDollarsPerPeriod * periods.length * 100)
    : null;
  const onPace = projectedCents !== null && targetCents !== null ? projectedCents >= targetCents : null;

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

    // Dashed forecast covers the in-progress week and all future weeks
    const forecastPerPeriod: number | undefined =
      !isComplete && avgDollarsPerPeriod > 0 ? Math.round(avgDollarsPerPeriod) : undefined;

    let forecastCumulative: number | undefined;
    if (i === lastCompletedIdx && lastCompletedIdx >= 0) {
      forecastCumulative = Math.round(cumCompletedDollars);
    } else if (i > lastCompletedIdx && lastCompletedIdx >= 0 && avgDollarsPerPeriod > 0) {
      forecastCumulative = Math.round(completedActualCents / 100 + (i - lastCompletedIdx) * avgDollarsPerPeriod);
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
  const numPeriods         = periods.length;
  const expectedPctPerPeriod = numPeriods > 0 ? 100 / numPeriods : null;

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

        <div className="bg-surface border border-line rounded-lg p-4">
          <div className="text-xs text-secondary mb-1">Actual Net Sales</div>
          <div className="text-xl font-semibold text-primary">{currency(actualCents)}</div>
          {targetCents !== null && (
            <div className="text-xs text-muted mt-0.5">{pct((actualCents / targetCents) * 100)} of target</div>
          )}
        </div>

        {/* Pace / projection */}
        <div className={`bg-surface border rounded-lg p-4 ${
          onPace === true ? "border-success-border" : onPace === false ? "border-danger-border" : "border-line"
        }`}>
          <div className="text-xs text-secondary mb-1">Projected {scope === "year" ? "Full Year" : "Full Quarter"}</div>
          <div className={`text-base sm:text-xl font-semibold ${
            onPace === true ? "text-success" : onPace === false ? "text-danger" : "text-primary"
          }`}>
            {projectedCents !== null ? currency(projectedCents) : "—"}
          </div>
          {onPace !== null && (
            <div className={`text-xs mt-0.5 ${onPace ? "text-success" : "text-danger"}`}>
              {onPace
                ? "On pace"
                : `Behind pace by ${currency(Math.abs(projectedCents! - targetCents!))}`}
              {onPace && targetCents !== null && projectedCents !== null && (
                <> · +{currency(projectedCents - targetCents)}</>
              )}
            </div>
          )}
        </div>

        {/* Gap to quarter target — raw arithmetic, not pace-adjusted */}
        <div className={`bg-surface border rounded-lg p-4 ${
          gapCents === null ? "border-line"
          : gapCents <= 0    ? "border-success-border"
          : "border-danger-border"
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
              <div className="text-base sm:text-xl font-semibold text-danger">{currency(gapCents)} to go</div>
              <div className="text-xs text-muted mt-0.5">vs. {tierLabel} goal</div>
            </>
          )}
        </div>

      </div>

      {/* Pace bar */}
      {targetCents !== null && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-secondary">
            <span>{pct(elapsedFrac * 100)} of {scope === "year" ? "year" : "quarter"} elapsed</span>
            <span>{pct((actualCents / targetCents) * 100)} of target reached</span>
          </div>
          <div className="relative h-3 bg-surface-mid rounded-full overflow-hidden">
            <div className="absolute top-0 bottom-0 w-0.5 bg-line-subtle z-10"
              style={{ left: `${Math.min(elapsedFrac * 100, 100)}%` }} />
            <div className={`h-full rounded-full transition-all ${onPace ? "bg-success-emphasis" : "bg-danger-emphasis"}`}
              style={{ width: `${Math.min((actualCents / targetCents) * 100, 100)}%` }} />
          </div>
          <div className="flex justify-between text-xs text-muted">
            <span>$0</span><span>{currency(targetCents)}</span>
          </div>
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
          {periods.map((p) => {
            const isFuture     = p.start > now;
            const isInProgress = p.start <= now && p.end > now;
            // For future periods, use the avg per-period forecast as a projected value
            const displayCents: number | null = isFuture
              ? (avgDollarsPerPeriod > 0 ? Math.round(avgDollarsPerPeriod * 100) : null)
              : p.net_sales_cents;

            const actualPct = (targetCents !== null && displayCents !== null)
              ? (displayCents / targetCents) * 100 : null;
            const variance  = (actualPct !== null && expectedPctPerPeriod !== null)
              ? actualPct - expectedPctPerPeriod : null;
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
                    actualCents >= targetCents ? "text-success" : "text-danger"
                  }`}>
                    {pct((actualCents / targetCents) * 100)}
                  </td>
                  <td className={`py-2 text-right font-mono text-xs ${
                    actualCents >= targetCents ? "text-success" : "text-danger"
                  }`}>
                    {(() => {
                      const v = ((actualCents / targetCents) * 100) - 100;
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
