"use client";

// Everything the forecast toggle adds to the Financials page apart from the
// table columns themselves: the summary line that says what the projection is
// built on, and the assumptions dialog whose levers reshape it.
//
// Nothing here computes a forecast — that is lib/finance/forecast/forecast.ts.
// This file only edits a ForecastAssumptions value and prints a ForecastResult.

import { useEffect, useState } from "react";
import { formatCurrencyCents } from "@/lib/format";
import Card from "@/app/components/ui/Card";
import ToggleChip from "@/app/components/ui/ToggleChip";
import { Modal } from "@/app/components/ui/Modal";
import { addMonths } from "@/lib/finance/forecast/drawdown";
import {
  BASE_ASSUMPTIONS,
  type ForecastAssumptions,
  type ForecastDrivers,
  type ForecastResult,
  type ScenarioItem,
} from "@/lib/finance/forecast/types";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (ym: string) => MONTH_NAMES[Number(ym.slice(5, 7)) - 1] ?? ym;

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

// ── Summary line ────────────────────────────────────────────────────────────

/** One sentence on what the projection is built from, and its headline figures. */
export function ForecastSummary({ result, drivers, statement }: {
  result: ForecastResult;
  drivers: ForecastDrivers;
  statement: "pl" | "cash_flow";
}) {
  const months = result.forecastMonths;
  const sum = (by: Record<string, number>) => months.reduce((total, m) => total + (by[m] ?? 0), 0);
  const basis = `${monthName(result.trailingMonths[0])}–${monthName(result.trailingMonths[result.trailingMonths.length - 1])}`;
  const avgBbl = sum(result.shippedBblByMonth) / months.length;
  const cash = result.cashEndCentsByMonth;
  const firstNegative = cash ? months.find((m) => cash[m] < 0) : undefined;
  const lastMonth = months[months.length - 1];

  return (
    <Card padding="p-3" className="mb-4 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-xs text-secondary">
      <span>
        <span className="font-semibold text-accent-soft">Forecast</span>{" "}
        next {months.length} months, from {basis} actuals and the shipping history of {drivers.matureBatchCount} finished batches
      </span>
      <span>
        {statement === "pl" ? "Revenue" : "Cash in from sales"}{" "}
        <span className="font-mono tabular-nums text-strong">{formatCurrencyCents(sum(result.revenueCentsByMonth))}</span>
      </span>
      <span>
        {statement === "pl" ? "Net income" : "Net operating cash"}{" "}
        <span className={`font-mono tabular-nums ${sum(result.netCentsByMonth) < 0 ? "text-danger" : "text-strong"}`}>
          {formatCurrencyCents(sum(result.netCentsByMonth))}
        </span>
      </span>
      <span>
        Shipments <span className="font-mono tabular-nums text-strong">{avgBbl.toFixed(0)} bbl/mo</span>
      </span>
      {cash && (
        <span>
          Cash at end of {monthName(lastMonth)}{" "}
          <span className={`font-mono tabular-nums ${cash[lastMonth] < 0 ? "text-danger" : "text-strong"}`}>
            {formatCurrencyCents(cash[lastMonth])}
          </span>
          {firstNegative && <span className="text-danger"> — runs out in {monthName(firstNegative)}</span>}
        </span>
      )}
    </Card>
  );
}
