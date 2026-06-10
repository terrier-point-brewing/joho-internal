"use client";

import { useEffect, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";
import {
  ResponsiveContainer, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from "recharts";

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
  return (cents / 100).toLocaleString("en-US", {
    style: "currency", currency: "USD",
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  });
}
function fmtDollars(d: number) {
  return d.toLocaleString("en-US", {
    style: "currency", currency: "USD",
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  });
}
function pct(n: number, decimals = 1) { return `${n.toFixed(decimals)}%`; }

function quarterDateRange(year: number, quarter: number) {
  const s = (quarter - 1) * 3;
  return { start: new Date(year, s, 1), end: new Date(year, s + 3, 0) };
}
function toISO(d: Date) { return d.toISOString().slice(0, 10); }
function addDays(d: Date, n: number) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

const MA = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function buildMonthlyPeriods(year: number, quarter: number): Omit<Period,"net_sales_cents"|"loading">[] {
  const { start } = quarterDateRange(year, quarter);
  return Array.from({ length: 3 }, (_, m) => {
    const ms = new Date(start.getFullYear(), start.getMonth() + m, 1);
    const me = new Date(start.getFullYear(), start.getMonth() + m + 1, 0);
    return { label: ms.toLocaleString("default",{month:"long",year:"numeric"}), shortLabel: MA[ms.getMonth()], start: toISO(ms), end: toISO(me) };
  });
}

function buildWeeklyPeriods(year: number, quarter: number): Omit<Period,"net_sales_cents"|"loading">[] {
  const { start, end } = quarterDateRange(year, quarter);
  return buildWeekRange(start, end);
}

function buildYearlyMonthlyPeriods(year: number): Omit<Period,"net_sales_cents"|"loading">[] {
  return Array.from({ length: 12 }, (_, m) => {
    const ms = new Date(year, m, 1);
    const me = new Date(year, m + 1, 0);
    return { label: ms.toLocaleString("default",{month:"long",year:"numeric"}), shortLabel: MA[m], start: toISO(ms), end: toISO(me) };
  });
}

function buildYearlyWeeklyPeriods(year: number): Omit<Period,"net_sales_cents"|"loading">[] {
  return buildWeekRange(new Date(year, 0, 1), new Date(year, 11, 31));
}

function snapToMonday(d: Date): Date {
  const day = d.getDay(); // 0=Sun, 1=Mon ...
  const diff = day === 0 ? -6 : 1 - day;
  const mon = new Date(d);
  mon.setDate(d.getDate() + diff);
  mon.setHours(0, 0, 0, 0);
  return mon;
}

function buildWeekRange(start: Date, end: Date): Omit<Period,"net_sales_cents"|"loading">[] {
  const out: Omit<Period,"net_sales_cents"|"loading">[] = [];
  let cur = snapToMonday(start);
  while (cur <= end) {
    const ae = (() => { const w = addDays(cur, 6); return w > end ? end : w; })();
    const shortLabel = `${MA[cur.getMonth()]} ${cur.getDate()}`;
    const label = ae.getMonth() === cur.getMonth()
      ? `${MA[cur.getMonth()]} ${cur.getDate()}–${ae.getDate()}`
      : `${MA[cur.getMonth()]} ${cur.getDate()} – ${MA[ae.getMonth()]} ${ae.getDate()}`;
    out.push({ label, shortLabel, start: toISO(cur), end: toISO(ae) });
    cur = addDays(ae, 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Custom tooltip
// ---------------------------------------------------------------------------

function ChartTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-xs shadow-lg">
      <div className="text-zinc-300 font-medium mb-1">{label}</div>
      {payload.map((p) => (
        <div key={p.name} style={{ color: p.color }} className="flex justify-between gap-4">
          <span>{p.name}</span>
          <span className="font-mono">{p.value != null ? fmtDollars(p.value) : "—"}</span>
        </div>
      ))}
    </div>
  );
}

const selectCls = "bg-zinc-800 border border-zinc-600 rounded px-1.5 py-1 sm:px-3 sm:py-2 text-xs sm:text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-amber-500";
const toggleBtn = (active: boolean) =>
  `px-2 py-1 sm:px-4 sm:py-2 text-xs sm:text-sm font-medium transition-colors ${active ? "bg-zinc-700 text-zinc-100" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AchievementTab() {
  const today       = new Date();
  const currentYear = today.getFullYear();
  const currentQ    = Math.ceil((today.getMonth() + 1) / 3) as 1|2|3|4;

  const [grain,      setGrain]      = useState<Grain>("weekly");
  const [scope,      setScope]      = useState<Scope>("quarter");
  const [year,       setYear]       = useState(currentYear);
  const [quarter,    setQuarter]    = useState<number>(currentQ);
  const [activeTier, setActiveTier] = useState<Tier>("target");
  const [chartView,  setChartView]  = useState<ChartView>("cumulative");
  const { data: targets = [] } = useQuery({
    queryKey: ["taproom", "targets"],
    queryFn: () => fetchJson<Target[]>("/api/targets"),
  });
  const [periods,    setPeriods]    = useState<Period[]>([]);

  const loadPeriods = useCallback(async () => {
    const base =
      scope === "year"
        ? grain === "monthly" ? buildYearlyMonthlyPeriods(year) : buildYearlyWeeklyPeriods(year)
        : grain === "monthly" ? buildMonthlyPeriods(year, quarter) : buildWeeklyPeriods(year, quarter);

    const now   = toISO(today);
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grain, scope, year, quarter]);

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

  // Pace / projection
  const rangeStart = scope === "year" ? new Date(year, 0, 1) : quarterDateRange(year, quarter).start;
  const rangeEnd   = scope === "year" ? new Date(year, 11, 31) : quarterDateRange(year, quarter).end;
  const totalMs    = rangeEnd.getTime() - rangeStart.getTime();
  const elapsedMs  = Math.min(Math.max(today.getTime() - rangeStart.getTime(), 0), totalMs);
  const elapsedFrac = totalMs > 0 ? elapsedMs / totalMs : 0;
  const projectedCents = elapsedFrac > 0 ? Math.round(actualCents / elapsedFrac) : null;
  const onPace = projectedCents !== null && targetCents !== null ? projectedCents >= targetCents : null;

  const activeTierColor = TIERS.find((t) => t.value === activeTier)?.color ?? "#f59e0b";
  const tierLabel       = TIERS.find((t) => t.value === activeTier)?.label ?? "Target";

  // ---------------------------------------------------------------------------
  // Chart data
  // ---------------------------------------------------------------------------

  const now = toISO(today);
  // Only fully-elapsed periods count toward the actuals average; the current in-progress
  // week is partial data and would pull the average down if included.
  const completedPeriods    = periods.filter((p) => p.end <= now && p.net_sales_cents !== null);
  const completedActualCents = completedPeriods.reduce((s, p) => s + (p.net_sales_cents ?? 0), 0);
  const avgDollarsPerPeriod = completedPeriods.length > 0 ? (completedActualCents / completedPeriods.length) / 100 : 0;
  const lastCompletedIdx    = periods.reduce<number>((last, p, i) => (p.end <= now && p.net_sales_cents !== null ? i : last), -1);

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
  const yAxisFmt = (v: number) => v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v}`;

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
        <div className="flex rounded overflow-hidden border border-zinc-700">
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

        <div className="flex rounded overflow-hidden border border-zinc-700">
          {([["monthly","Mo"],["weekly","Wk"]] as const).map(([g, lbl]) => (
            <button key={g} onClick={() => setGrain(g as Grain)} className={toggleBtn(grain === g)}>
              <span className="sm:hidden">{lbl}</span>
              <span className="hidden sm:inline">{g.charAt(0).toUpperCase() + g.slice(1)}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Tier selector — label + 2×2 on mobile, single row on sm+ */}
      <div className="space-y-1.5 sm:space-y-0">
        <span className="text-xs text-zinc-500">Compare vs.</span>
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
                  activeTier === t.value ? "border-current bg-zinc-800" : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
                }`}
                style={activeTier === t.value ? { color: t.color, borderColor: t.color } : {}}>
                {t.label}
              </button>
            );
          })}
          {quarterTiers.length === 0 && (
            <span className="col-span-2 text-xs text-zinc-600 italic">
              {scope === "year" ? "Need all 4 quarters set for year total" : "No targets set for this quarter"}
            </span>
          )}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">

        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <div className="text-xs text-zinc-400 mb-1">{scope === "year" ? "Annual" : "Quarterly"} Target</div>
          <div className="text-base sm:text-xl font-semibold text-zinc-100">
            {targetCents !== null ? currency(targetCents) : <span className="text-zinc-500 text-sm sm:text-base">Not set</span>}
          </div>
          {scope === "year" && targetCents === null && targets.filter(t => t.year === year && t.tier === activeTier).length > 0 && (
            <div className="text-xs text-zinc-600 mt-0.5">
              {targets.filter(t => t.year === year && t.tier === activeTier).length}/4 quarters set
            </div>
          )}
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <div className="text-xs text-zinc-400 mb-1">Actual Net Sales</div>
          <div className="text-xl font-semibold text-zinc-100">{currency(actualCents)}</div>
          {targetCents !== null && (
            <div className="text-xs text-zinc-500 mt-0.5">{pct((actualCents / targetCents) * 100)} of target</div>
          )}
        </div>

        {/* Pace / projection */}
        <div className={`bg-zinc-900 border rounded-lg p-4 ${
          onPace === true ? "border-green-700" : onPace === false ? "border-red-700" : "border-zinc-800"
        }`}>
          <div className="text-xs text-zinc-400 mb-1">Projected {scope === "year" ? "Full Year" : "Full Quarter"}</div>
          <div className={`text-base sm:text-xl font-semibold ${
            onPace === true ? "text-green-400" : onPace === false ? "text-red-400" : "text-zinc-100"
          }`}>
            {projectedCents !== null ? currency(projectedCents) : "—"}
          </div>
          {onPace !== null && (
            <div className={`text-xs mt-0.5 ${onPace ? "text-green-500" : "text-red-500"}`}>
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
        <div className={`bg-zinc-900 border rounded-lg p-4 ${
          gapCents === null ? "border-zinc-800"
          : gapCents <= 0    ? "border-green-800"
          : "border-red-900"
        }`}>
          <div className="text-xs text-zinc-400 mb-1">Gap to {scope === "year" ? "Annual" : "Quarter"} Target</div>
          {gapCents === null ? (
            <div className="text-base sm:text-xl font-semibold text-zinc-500">—</div>
          ) : gapCents <= 0 ? (
            <>
              <div className="text-base sm:text-xl font-semibold text-green-400">{currency(Math.abs(gapCents))} ahead</div>
              <div className="text-xs text-green-600 mt-0.5">Target exceeded</div>
            </>
          ) : (
            <>
              <div className="text-base sm:text-xl font-semibold text-red-400">{currency(gapCents)} to go</div>
              <div className="text-xs text-zinc-500 mt-0.5">vs. {tierLabel} goal</div>
            </>
          )}
        </div>

      </div>

      {/* Pace bar */}
      {targetCents !== null && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-zinc-400">
            <span>{pct(elapsedFrac * 100)} of {scope === "year" ? "year" : "quarter"} elapsed</span>
            <span>{pct((actualCents / targetCents) * 100)} of target reached</span>
          </div>
          <div className="relative h-3 bg-zinc-800 rounded-full overflow-hidden">
            <div className="absolute top-0 bottom-0 w-0.5 bg-zinc-500 z-10"
              style={{ left: `${Math.min(elapsedFrac * 100, 100)}%` }} />
            <div className={`h-full rounded-full transition-all ${onPace ? "bg-green-600" : "bg-red-600"}`}
              style={{ width: `${Math.min((actualCents / targetCents) * 100, 100)}%` }} />
          </div>
          <div className="flex justify-between text-xs text-zinc-500">
            <span>$0</span><span>{currency(targetCents)}</span>
          </div>
        </div>
      )}

      {/* Chart */}
      {periods.length > 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 sm:p-5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
            <div className="text-sm font-medium text-zinc-300">
              {chartView === "per-period"
                ? `Net Sales per ${grain === "monthly" ? "Month" : "Week"}`
                : `Cumulative Net Sales`}
            </div>
            <div className="flex rounded overflow-hidden border border-zinc-700 self-start sm:self-auto">
              {([["per-period","Per Period"],["cumulative","Cumulative"]] as const).map(([v, lbl]) => (
                <button key={v} onClick={() => setChartView(v)}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                    chartView === v ? "bg-zinc-700 text-zinc-100" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                  }`}>
                  {lbl}
                </button>
              ))}
            </div>
          </div>

          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData}
              margin={{ top: 8, right: 16, bottom: grain === "weekly" ? 30 : 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" vertical={false} />
              <XAxis dataKey="name" interval={0}
                tick={grain === "weekly" ? { fill:"#a1a1aa", fontSize:10, dy:4 } : { fill:"#a1a1aa", fontSize:11 }}
                angle={grain === "weekly" ? -45 : 0}
                textAnchor={grain === "weekly" ? "end" : "middle"}
                axisLine={false} tickLine={false}
                height={grain === "weekly" ? 52 : 24} />
              <YAxis tickFormatter={yAxisFmt} domain={yDomain}
                tick={{ fill:"#a1a1aa", fontSize:11 }} axisLine={false} tickLine={false} width={44} />
              <Tooltip content={<ChartTooltip />} />

              {chartView === "per-period" && (
                <>
                  {perPeriodTargetDollars !== null && (
                    <ReferenceLine y={perPeriodTargetDollars} stroke={activeTierColor}
                      strokeDasharray="5 4" strokeWidth={1.5}
                      label={{ value:`Avg ${tierLabel}`, position:"insideTopRight", fill:activeTierColor, fontSize:10 }} />
                  )}
                  <Line type="monotone" dataKey="Net Sales" stroke="#60a5fa" strokeWidth={2}
                    dot={{ r:4, fill:"#60a5fa", strokeWidth:0 }} activeDot={{ r:5 }} connectNulls={false} />
                  <Line type="monotone" dataKey="Forecast" stroke="#60a5fa" strokeWidth={2}
                    strokeDasharray="5 4" dot={{ r:4, fill:"#60a5fa", strokeWidth:0, opacity:0.5 }}
                    activeDot={{ r:5 }} connectNulls={false} />
                </>
              )}
              {chartView === "cumulative" && (
                <>
                  {cumulativeTargetDollars !== null && (
                    <ReferenceLine y={cumulativeTargetDollars} stroke={activeTierColor}
                      strokeDasharray="5 4" strokeWidth={1.5}
                      label={{ value:tierLabel, position:"insideTopRight", fill:activeTierColor, fontSize:10 }} />
                  )}
                  <Line type="monotone" dataKey="Cumulative" stroke="#34d399" strokeWidth={2}
                    dot={{ r:4, fill:"#34d399", strokeWidth:0 }} activeDot={{ r:5 }} connectNulls={false} />
                  <Line type="monotone" dataKey="Forecast Total" stroke="#34d399" strokeWidth={2}
                    strokeDasharray="5 4" dot={{ r:4, fill:"#34d399", strokeWidth:0, opacity:0.5 }}
                    activeDot={{ r:5 }} connectNulls={false} />
                </>
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Period table */}
      <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
      <table className="w-full text-sm border-collapse min-w-[460px]">
        <thead>
          <tr className="text-xs text-zinc-400 uppercase border-b border-zinc-800">
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
              <tr key={p.start} className={`border-b text-zinc-200 ${
                isFuture ? "border-zinc-800/20 opacity-60" : "border-zinc-800/40"
              }`}>
                <td className="py-2 pr-3 sm:pr-6">
                  <span className={isFuture ? "text-zinc-500" : "text-zinc-300"}>
                    {p.label}
                  </span>
                  {isFuture && (
                    <span className="ml-1 text-xs text-zinc-600 italic">proj.</span>
                  )}
                  {isInProgress && (
                    <span className="ml-1 text-xs text-amber-600 italic">in prog.</span>
                  )}
                </td>
                <td className="py-2 pr-3 sm:pr-6 text-right font-mono">
                  {p.loading ? (
                    <span className="text-zinc-500">Loading…</span>
                  ) : isFuture ? (
                    displayCents !== null
                      ? <span className="text-zinc-500 italic">{currency(displayCents)}</span>
                      : <span className="text-zinc-700">—</span>
                  ) : isInProgress && p.net_sales_cents !== null ? (
                    <span className="text-zinc-400 italic">{currency(p.net_sales_cents)}</span>
                  ) : p.net_sales_cents !== null ? (
                    currency(p.net_sales_cents)
                  ) : (
                    <span className="text-zinc-600">—</span>
                  )}
                </td>
                {targetCents !== null && (
                  <>
                    <td className={`py-2 pr-2 sm:pr-4 text-right font-mono ${
                      isFuture || isInProgress ? "text-zinc-600 italic"
                      : actualPct === null ? "text-zinc-600"
                      : ahead            ? "text-green-400"
                      : "text-red-400"
                    }`}>
                      {actualPct !== null ? pct(actualPct) : "—"}
                    </td>
                    <td className={`py-2 text-right font-mono text-xs ${
                      isFuture || isInProgress ? "text-zinc-700"
                      : variance === null ? "text-zinc-600"
                      : ahead             ? "text-green-500"
                      : "text-red-500"
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
            <tr className="text-zinc-100 font-medium border-t border-zinc-700">
              <td className="py-2 pr-3 sm:pr-6">Total (actual)</td>
              <td className="py-2 pr-3 sm:pr-6 text-right font-mono">{currency(actualCents)}</td>
              {targetCents !== null && (
                <>
                  <td className={`py-2 pr-2 sm:pr-4 text-right font-mono ${
                    actualCents >= targetCents ? "text-green-400" : "text-red-400"
                  }`}>
                    {pct((actualCents / targetCents) * 100)}
                  </td>
                  <td className={`py-2 text-right font-mono text-xs ${
                    actualCents >= targetCents ? "text-green-500" : "text-red-500"
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
