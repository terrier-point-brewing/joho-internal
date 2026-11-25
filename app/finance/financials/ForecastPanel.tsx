"use client";

// Everything the forecast toggle adds to the Financials page apart from the
// table columns themselves: the overview strip (what the projection is built
// on, the cash runway, the scenario comparison and the accuracy check) and the
// assumptions dialog whose levers reshape it.
//
// Nothing here computes a forecast — that is lib/finance/forecast/forecast.ts.
// This file only edits a ForecastAssumptions value and prints a ForecastResult.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import { formatCurrencyCents } from "@/lib/format";
import Card from "@/app/components/ui/Card";
import ToggleChip from "@/app/components/ui/ToggleChip";
import { Modal } from "@/app/components/ui/Modal";
import { addMonths } from "@/lib/finance/forecast/drawdown";
import { cashOutlook } from "@/lib/finance/forecast/forecast";
import {
  BASE_ASSUMPTIONS,
  type CashOutlook,
  type ForecastAssumptions,
  type ForecastDrivers,
  type ForecastResult,
  type ForecastSnapshot,
  type ScenarioItem,
} from "@/lib/finance/forecast/types";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (ym: string) => MONTH_NAMES[Number(ym.slice(5, 7)) - 1] ?? ym;
/** "Feb ’27" — for a month that may sit in another year. */
const monthYear = (ym: string) => `${monthName(ym)} ’${ym.slice(2, 4)}`;

// ── Persisted settings ──────────────────────────────────────────────────────

const STORAGE_KEY = "fin_forecast_v1";

interface ForecastSettings {
  on: boolean;
  assumptions: ForecastAssumptions;
}

/**
 * The toggle and the levers, remembered per browser so a scenario survives a
 * reload. Read after hydration (the server always renders "off"), and merged
 * over the base so a lever added later has a value in an older saved scenario.
 */
export function useForecastSettings() {
  const [settings, setSettings] = useState<ForecastSettings>({ on: false, assumptions: BASE_ASSUMPTIONS });

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored) as Partial<ForecastSettings>;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSettings({ on: parsed.on === true, assumptions: { ...BASE_ASSUMPTIONS, ...(parsed.assumptions ?? {}) } });
    } catch {
      // A corrupt saved scenario is not worth an error: start from the base.
    }
  }, []);

  const update = (next: ForecastSettings) => {
    setSettings(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* private mode: not remembered */ }
  };

  return {
    on: settings.on,
    assumptions: settings.assumptions,
    setOn: (on: boolean) => update({ ...settings, on }),
    setAssumptions: (assumptions: ForecastAssumptions) => update({ ...settings, assumptions }),
  };
}

// ── Presets ─────────────────────────────────────────────────────────────────

type PresetKey = "base" | "downside" | "upside";

/** A preset moves the levers and leaves the horizon, paused partners and typed-in lines alone. */
function applyPreset(key: PresetKey, current: ForecastAssumptions, drivers: ForecastDrivers): ForecastAssumptions {
  const keep = { horizonMonths: current.horizonMonths, pausedPartnerIds: current.pausedPartnerIds, items: current.items };
  const pace = (factor: number) => Math.round(drivers.brewPaceBblPerMonth * factor);
  if (key === "downside") {
    return {
      ...BASE_ASSUMPTIONS, ...keep,
      brewBblPerMonth: pace(0.8), drawdownSpeedPct: -20, taproomGrowthPctPerMonth: -2,
      ingredientCostPct: 10, extraDaysToCollect: 15,
    };
  }
  if (key === "upside") {
    return {
      ...BASE_ASSUMPTIONS, ...keep,
      brewBblPerMonth: pace(1.2), drawdownSpeedPct: 10, taproomGrowthPctPerMonth: 2,
      contractPricePct: 5, distributionPricePct: 5,
    };
  }
  return { ...BASE_ASSUMPTIONS, ...keep };
}

/** How many levers sit away from "as history" — shown on the Assumptions button. */
export function changedLeverCount(a: ForecastAssumptions): number {
  const numeric: (keyof ForecastAssumptions)[] = [
    "drawdownSpeedPct", "yieldLossPct", "contractPricePct", "distributionPricePct",
    "taproomGrowthPctPerMonth", "ingredientCostPct", "payrollPct", "otherOpexPct", "extraDaysToCollect",
  ];
  return (
    numeric.filter((k) => a[k] !== 0).length +
    (a.brewBblPerMonth !== null ? 1 : 0) +
    a.pausedPartnerIds.length +
    a.items.filter((i) => i.label.trim() && i.amountCents !== 0).length
  );
}

// ── Assumptions dialog ──────────────────────────────────────────────────────

function NumberLever({ label, hint, value, onChange, suffix, step = 1 }: {
  label: string;
  hint?: string;
  value: number;
  onChange: (v: number) => void;
  suffix: string;
  step?: number;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-xs text-body">
      <span className="min-w-0">
        {label}
        {hint && <span className="block text-faint">{hint}</span>}
      </span>
      <span className="flex items-center gap-1.5 shrink-0">
        <input
          type="number"
          inputMode="decimal"
          step={step}
          value={Number.isFinite(value) ? value : 0}
          onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
          className="inp-sm w-20 text-right font-mono tabular-nums"
        />
        <span className="w-12 text-faint">{suffix}</span>
      </span>
    </label>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h4 className="text-xs font-semibold text-secondary uppercase tracking-wide">{title}</h4>
      {children}
    </section>
  );
}

export function ForecastAssumptionsModal({ assumptions: a, onChange, drivers, forecastMonths, onClose }: {
  assumptions: ForecastAssumptions;
  onChange: (next: ForecastAssumptions) => void;
  drivers: ForecastDrivers;
  forecastMonths: string[];
  onClose: () => void;
}) {
  const set = <K extends keyof ForecastAssumptions>(key: K, value: ForecastAssumptions[K]) => onChange({ ...a, [key]: value });
  const firstMonth = forecastMonths[0] ?? addMonths(drivers.openMonth, 1);
  const setItem = (id: string, patch: Partial<ScenarioItem>) =>
    set("items", a.items.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  return (
    <Modal title="Forecast assumptions" onClose={onClose} wide>
      <div className="flex flex-col gap-5 p-5 overflow-y-auto">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-muted mr-1">Start from:</span>
          <button type="button" className="btn-secondary" onClick={() => onChange(applyPreset("base", a, drivers))}>Base</button>
          <button type="button" className="btn-secondary" onClick={() => onChange(applyPreset("downside", a, drivers))}>Downside</button>
          <button type="button" className="btn-secondary" onClick={() => onChange(applyPreset("upside", a, drivers))}>Upside</button>
          <span className="text-xs text-faint">0 on any lever means &ldquo;same as recent history&rdquo;.</span>
        </div>

        <Group title="Horizon">
          <div className="flex items-center gap-1.5">
            {([3, 6, 12] as const).map((n) => (
              <ToggleChip key={n} active={a.horizonMonths === n} onClick={() => set("horizonMonths", n)}>{n} months</ToggleChip>
            ))}
          </div>
        </Group>

        <Group title="Volume & timing">
          <NumberLever
            label="Brewing pace"
            hint={`Recent pace is ${Math.round(drivers.brewPaceBblPerMonth)} bbl a month`}
            value={a.brewBblPerMonth ?? Math.round(drivers.brewPaceBblPerMonth)}
            onChange={(v) => set("brewBblPerMonth", v === Math.round(drivers.brewPaceBblPerMonth) ? null : Math.max(0, v))}
            suffix="bbl/mo"
            step={5}
          />
          <NumberLever label="Beer ships faster (+) or slower (−)" hint="Against the historical brew-to-shipment curve" value={a.drawdownSpeedPct} onChange={(v) => set("drawdownSpeedPct", v)} suffix="%" step={5} />
          <NumberLever label="Extra yield loss" hint="Share of each batch that never ships" value={a.yieldLossPct} onChange={(v) => set("yieldLossPct", v)} suffix="%" />
        </Group>

        <Group title="Price & taproom">
          <NumberLever label="Contract brewing price" value={a.contractPricePct} onChange={(v) => set("contractPricePct", v)} suffix="%" />
          <NumberLever label="Distribution price" value={a.distributionPricePct} onChange={(v) => set("distributionPricePct", v)} suffix="%" />
          <NumberLever label="Taproom sales growth" hint="Compounds every month" value={a.taproomGrowthPctPerMonth} onChange={(v) => set("taproomGrowthPctPerMonth", v)} suffix="%/mo" step={0.5} />
        </Group>

        <Group title="Costs">
          <NumberLever label="Ingredient & packaging cost" value={a.ingredientCostPct} onChange={(v) => set("ingredientCostPct", v)} suffix="%" />
          <NumberLever label="Payroll" hint="A hire or a raise, as a share of today's payroll" value={a.payrollPct} onChange={(v) => set("payrollPct", v)} suffix="%" />
          <NumberLever label="Other operating costs" value={a.otherOpexPct} onChange={(v) => set("otherOpexPct", v)} suffix="%" />
        </Group>

        <Group title="Cash timing">
          <NumberLever label="Invoices paid later by" hint="Affects the Cash Flow forecast only" value={a.extraDaysToCollect} onChange={(v) => set("extraDaysToCollect", Math.max(0, v))} suffix="days" step={5} />
        </Group>

        {drivers.partners.length > 0 && (
          <Group title="Customers">
            <p className="text-xs text-faint">Tick a partner to see the forecast without their orders.</p>
            {drivers.partners.map((p) => {
              const shares = Object.entries(p.shareByChannel)
                .filter(([, s]) => (s ?? 0) > 0)
                .map(([c, s]) => `${Math.round((s ?? 0) * 100)}% of ${c.replace("_", " ")}`)
                .join(", ");
              return (
                <label key={p.id} className="flex items-center gap-2 text-xs text-body">
                  <input
                    type="checkbox"
                    checked={a.pausedPartnerIds.includes(p.id)}
                    onChange={(e) =>
                      set("pausedPartnerIds", e.target.checked ? [...a.pausedPartnerIds, p.id] : a.pausedPartnerIds.filter((id) => id !== p.id))
                    }
                  />
                  Pause {p.name}
                  <span className="text-faint">{shares} invoiced recently</span>
                </label>
              );
            })}
          </Group>
        )}

        <Group title="One-off and new recurring items">
          {a.items.map((item) => (
            <div key={item.id} className="flex items-center gap-2 flex-wrap">
              <input
                type="text"
                value={item.label}
                placeholder="e.g. New fermenter"
                onChange={(e) => setItem(item.id, { label: e.target.value })}
                className="inp-sm flex-1 min-w-32"
              />
              <input
                type="number"
                inputMode="decimal"
                value={item.amountCents / 100}
                onChange={(e) => setItem(item.id, { amountCents: Math.round(Number(e.target.value || 0) * 100) })}
                className="inp-sm w-24 text-right font-mono tabular-nums"
                aria-label="Cost in dollars"
              />
              <select value={item.startMonth} onChange={(e) => setItem(item.id, { startMonth: e.target.value })} className="inp-sm w-auto">
                {forecastMonths.map((m) => <option key={m} value={m}>{monthName(m)} {m.slice(0, 4)}</option>)}
              </select>
              <ToggleChip active={item.recurring} onClick={() => setItem(item.id, { recurring: !item.recurring })}>
                {item.recurring ? "Every month" : "Once"}
              </ToggleChip>
              <button type="button" className="btn-secondary" aria-label={`Remove ${item.label || "item"}`} onClick={() => set("items", a.items.filter((i) => i.id !== item.id))}>
                <span aria-hidden>×</span>
              </button>
            </div>
          ))}
          <div>
            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                set("items", [...a.items, { id: `${Date.now()}-${a.items.length}`, label: "", amountCents: 0, startMonth: firstMonth, recurring: false }])
              }
            >
              Add an item
            </button>
            <span className="ml-2 text-xs text-faint">Enter a cost in dollars; a negative amount is extra income.</span>
          </div>
        </Group>
      </div>
    </Modal>
  );
}

// ── Overview: headline, cash runway, scenario comparison, accuracy ──────────

/** The P&L and cash-flow forecasts for one set of assumptions. Either is null when its statement has no finished month. */
export interface ScenarioForecast {
  pl: ForecastResult | null;
  cashFlow: ForecastResult | null;
}

const sumOver = (by: Record<string, number>, months: string[]) => months.reduce((total, m) => total + (by[m] ?? 0), 0);

function Money({ cents, plain = false }: { cents: number | null | undefined; plain?: boolean }) {
  if (cents === null || cents === undefined) return <span className="text-faint">—</span>;
  return <span className={`font-mono tabular-nums ${cents < 0 && !plain ? "text-danger" : "text-strong"}`}>{formatCurrencyCents(cents)}</span>;
}

/** The runway sentence: where cash is, where it is headed, and whether that is a problem. */
function CashCallout({ outlook }: { outlook: CashOutlook }) {
  const tail = outlook.runsOutMonth
    ? <span className="font-semibold text-danger"> — runs out in {monthYear(outlook.runsOutMonth)}</span>
    : outlook.runwayMonthsAfter !== null
      ? outlook.runwayMonthsAfter > 24
        ? <span> — more than two years of runway after that at this burn</span>
        : <span> — about {Math.max(1, Math.round(outlook.runwayMonthsAfter))} more months after that at this burn</span>
      : <span> — not burning cash</span>;
  return (
    <span title="Cash today plus forecast net operating cash. Loans, owner draws and equipment purchases are not included unless you add them as items.">
      Cash <Money cents={outlook.todayCents} /> today → <Money cents={outlook.endCents} /> by end of {monthYear(outlook.endMonth)}
      {outlook.lowMonth !== outlook.endMonth && !outlook.runsOutMonth && (
        <> (low point <Money cents={outlook.lowCents} /> in {monthName(outlook.lowMonth)})</>
      )}
      {tail}
    </span>
  );
}

function sameAssumptions(x: ForecastAssumptions, y: ForecastAssumptions): boolean {
  return (Object.keys(BASE_ASSUMPTIONS) as (keyof ForecastAssumptions)[]).every((k) => JSON.stringify(x[k]) === JSON.stringify(y[k]));
}

/** Base, Downside and Upside side by side, plus the reader's own scenario when it is none of the three. */
function ScenarioCompare({ run, assumptions, drivers, onUse }: {
  run: (a: ForecastAssumptions) => ScenarioForecast;
  assumptions: ForecastAssumptions;
  drivers: ForecastDrivers;
  onUse: (a: ForecastAssumptions) => void;
}) {
  const presets = (["base", "downside", "upside"] as const).map((key) => ({
    label: key === "base" ? "Base" : key === "downside" ? "Downside" : "Upside",
    assumptions: applyPreset(key, assumptions, drivers),
  }));
  const columns = presets.some((p) => sameAssumptions(p.assumptions, assumptions))
    ? presets
    : [...presets, { label: "Yours", assumptions }];
  const results = columns.map((c) => {
    const forecast = run(c.assumptions);
    return { ...c, forecast, outlook: forecast.cashFlow ? cashOutlook(forecast.cashFlow, drivers.cashOnHandCents) : null, current: sameAssumptions(c.assumptions, assumptions) };
  });
  const horizon = results[0]?.forecast.pl?.forecastMonths ?? results[0]?.forecast.cashFlow?.forecastMonths ?? [];
  const endMonth = results.find((r) => r.outlook)?.outlook?.endMonth;

  const lines: { label: string; cell: (r: (typeof results)[number]) => React.ReactNode }[] = [
    { label: `Revenue, next ${horizon.length} months`, cell: (r) => <Money cents={r.forecast.pl ? sumOver(r.forecast.pl.revenueCentsByMonth, horizon) : null} /> },
    { label: `Net income, next ${horizon.length} months`, cell: (r) => <Money cents={r.forecast.pl ? sumOver(r.forecast.pl.netCentsByMonth, horizon) : null} /> },
    {
      label: "Shipments",
      cell: (r) => {
        const f = r.forecast.pl ?? r.forecast.cashFlow;
        return f && horizon.length > 0
          ? <span className="font-mono tabular-nums text-strong">{(sumOver(f.shippedBblByMonth, horizon) / horizon.length).toFixed(0)} bbl/mo</span>
          : <span className="text-faint">—</span>;
      },
    },
    { label: endMonth ? `Cash at end of ${monthYear(endMonth)}` : "Cash at end", cell: (r) => <Money cents={r.outlook?.endCents} /> },
    { label: "Lowest cash", cell: (r) => (r.outlook ? <><Money cents={r.outlook.lowCents} /> <span className="text-faint">{monthName(r.outlook.lowMonth)}</span></> : <span className="text-faint">—</span>) },
    {
      label: "Cash runs out",
      cell: (r) =>
        r.outlook?.runsOutMonth
          ? <span className="font-semibold text-danger">{monthYear(r.outlook.runsOutMonth)}</span>
          : <span className="text-secondary">Not within {horizon.length} months</span>,
    },
  ];

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-line">
            <th className="py-1.5 pr-3 text-left font-medium text-muted">Scenario</th>
            {results.map((r) => (
              <th key={r.label} className="py-1.5 px-3 text-right font-semibold text-secondary whitespace-nowrap">
                {r.label}
                {r.current
                  ? <span className="ml-1.5 font-normal text-accent-soft">showing</span>
                  : <button type="button" className="ml-1.5 font-normal text-accent hover:underline" onClick={() => onUse(r.assumptions)}>use</button>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.label} className="border-t border-line/40">
              <td className="py-1.5 pr-3 text-secondary whitespace-nowrap">{line.label}</td>
              {results.map((r) => <td key={r.label} className="py-1.5 px-3 text-right whitespace-nowrap">{line.cell(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-faint">
        Each scenario keeps your horizon, paused customers and added items. Downside: brewing −20%, beer ships 20% slower, taproom −2% a month, ingredients +10%, invoices paid 15 days later. Upside: brewing +20%, ships 10% faster, taproom +2% a month, prices +5%.
      </p>
    </div>
  );
}

/** What past forecasts said about months that have since happened, against what those months came to. */
function ForecastAccuracy({ statement, actuals, openMonth }: {
  statement: "pl" | "cash_flow";
  actuals: { revenue: Record<string, number>; net: Record<string, number> };
  openMonth: string;
}) {
  const { data, error, isFetching } = useQuery({
    queryKey: queryKeys.finance.forecastSnapshots(),
    queryFn: () => fetchJson<ForecastSnapshot[]>("/api/finance/forecast/snapshots"),
    staleTime: 5 * 60_000,
  });
  if (error) return <p className="text-xs text-danger">Could not load saved forecasts: {error instanceof Error ? error.message : "failed to load"}</p>;
  if (!data) return <p className="text-xs text-faint">{isFetching ? "Loading…" : "No saved forecasts."}</p>;

  const mine = data.filter((s) => s.statement === statement);
  // For each finished month, the latest forecast made before it began.
  const byTarget = new Map<string, ForecastSnapshot>();
  for (const s of mine) {
    if (s.targetMonth >= openMonth || !(s.targetMonth in actuals.net)) continue;
    const held = byTarget.get(s.targetMonth);
    if (!held || s.madeMonth > held.madeMonth) byTarget.set(s.targetMonth, s);
  }
  const rows = [...byTarget.values()].sort((x, y) => x.targetMonth.localeCompare(y.targetMonth));
  const names = statement === "pl" ? { revenue: "Revenue", net: "Net income" } : { revenue: "Cash in from sales", net: "Net operating cash" };

  if (rows.length === 0) {
    const first = mine[0];
    return (
      <p className="text-xs text-secondary">
        {first
          ? `Forecasts have been saved daily since ${first.madeOn}. ${monthYear(first.targetMonth)} will be the first month checked, once it has ended.`
          : "No forecast has been saved yet. One is saved every day; the first comparison appears once a forecast month has ended."}
      </p>
    );
  }

  const miss = (forecast: number, actual: number) =>
    actual === 0 ? null : ((forecast - actual) / Math.abs(actual)) * 100;
  const Miss = ({ value }: { value: number | null }) =>
    value === null
      ? <span className="text-faint">—</span>
      : <span className={`font-mono tabular-nums ${Math.abs(value) > 15 ? "text-danger" : "text-secondary"}`}>{value > 0 ? "+" : ""}{value.toFixed(0)}%</span>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-line text-muted">
            <th className="py-1.5 pr-3 text-left font-medium">Month</th>
            <th className="py-1.5 px-3 text-left font-medium">Forecast made</th>
            <th className="py-1.5 px-3 text-right font-medium">{names.revenue}: forecast</th>
            <th className="py-1.5 px-3 text-right font-medium">Actual</th>
            <th className="py-1.5 px-3 text-right font-medium">Off by</th>
            <th className="py-1.5 px-3 text-right font-medium">{names.net}: forecast</th>
            <th className="py-1.5 px-3 text-right font-medium">Actual</th>
            <th className="py-1.5 px-3 text-right font-medium">Off by</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.targetMonth} className="border-t border-line/40">
              <td className="py-1.5 pr-3 text-secondary whitespace-nowrap">{monthYear(s.targetMonth)}</td>
              <td className="py-1.5 px-3 text-faint whitespace-nowrap">{s.madeOn}</td>
              <td className="py-1.5 px-3 text-right"><Money cents={s.revenueCents} /></td>
              <td className="py-1.5 px-3 text-right"><Money cents={actuals.revenue[s.targetMonth]} /></td>
              <td className="py-1.5 px-3 text-right"><Miss value={miss(s.revenueCents, actuals.revenue[s.targetMonth])} /></td>
              <td className="py-1.5 px-3 text-right"><Money cents={s.netCents} /></td>
              <td className="py-1.5 px-3 text-right"><Money cents={actuals.net[s.targetMonth]} /></td>
              <td className="py-1.5 px-3 text-right"><Money cents={s.netCents - actuals.net[s.targetMonth]} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-faint">Each month is checked against the base-case forecast saved before it began. A plus means the forecast was too high.</p>
    </div>
  );
}

/**
 * The strip above the table: what the projection is built on, its headline
 * figures and the cash runway, with the scenario comparison and the accuracy
 * check one click away.
 */
export function ForecastOverview({ scenario, drivers, statement, assumptions, onUse, run, accuracy }: {
  scenario: ScenarioForecast;
  drivers: ForecastDrivers;
  statement: "pl" | "cash_flow" | "balance_sheet";
  assumptions: ForecastAssumptions;
  onUse: (a: ForecastAssumptions) => void;
  run: (a: ForecastAssumptions) => ScenarioForecast;
  /** Actual revenue and net per month for the statement the accuracy check reads (the P&L, except on the Cash Flow tab). */
  accuracy: { statement: "pl" | "cash_flow"; actuals: { revenue: Record<string, number>; net: Record<string, number> } } | null;
}) {
  const [open, setOpen] = useState<"compare" | "accuracy" | null>(null);
  // The balance sheet has no flow of its own to headline, so it quotes the P&L.
  const headline = statement === "cash_flow" ? scenario.cashFlow : scenario.pl;
  const basisOf = headline ?? scenario.cashFlow;
  if (!basisOf) return null;
  const months = basisOf.forecastMonths;
  const basis = `${monthName(basisOf.trailingMonths[0])}–${monthName(basisOf.trailingMonths[basisOf.trailingMonths.length - 1])}`;
  const outlook = scenario.cashFlow ? cashOutlook(scenario.cashFlow, drivers.cashOnHandCents) : null;
  const cashFlowNames = statement === "cash_flow";

  return (
    <Card padding="p-3" className="mb-4 flex flex-col gap-2 text-xs text-secondary">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <span>
          <span className="font-semibold text-accent-soft">Forecast</span>{" "}
          next {months.length} months, from {basis} actuals and the shipping history of {drivers.matureBatchCount} finished batches
        </span>
        {headline && (
          <>
            <span>{cashFlowNames ? "Cash in from sales" : "Revenue"} <Money cents={sumOver(headline.revenueCentsByMonth, months)} plain /></span>
            <span>{cashFlowNames ? "Net operating cash" : "Net income"} <Money cents={sumOver(headline.netCentsByMonth, months)} /></span>
            <span>
              Shipments{" "}
              <span className="font-mono tabular-nums text-strong">{(sumOver(headline.shippedBblByMonth, months) / months.length).toFixed(0)} bbl/mo</span>
            </span>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {outlook && <CashCallout outlook={outlook} />}
        <span className="flex items-center gap-1.5 ml-auto">
          <ToggleChip active={open === "compare"} onClick={() => setOpen(open === "compare" ? null : "compare")}>Compare scenarios</ToggleChip>
          {accuracy && (
            <ToggleChip active={open === "accuracy"} onClick={() => setOpen(open === "accuracy" ? null : "accuracy")}>Accuracy</ToggleChip>
          )}
        </span>
      </div>
      {open === "compare" && (
        <div className="border-t border-line pt-2">
          <ScenarioCompare run={run} assumptions={assumptions} drivers={drivers} onUse={onUse} />
        </div>
      )}
      {open === "accuracy" && accuracy && (
        <div className="border-t border-line pt-2">
          <ForecastAccuracy statement={accuracy.statement} actuals={accuracy.actuals} openMonth={drivers.openMonth} />
        </div>
      )}
    </Card>
  );
}
