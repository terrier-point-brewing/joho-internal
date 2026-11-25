// The forecast itself: a statement's rows, extended a few months past today.
//
// Every line is forecast from its own recent history by one named method, so
// a reader can always ask "why is this number what it is" and get one answer:
//
//   Beer sold on invoice   recent revenue × (projected shipments ÷ recent shipments)
//   Taproom                recent average, grown by the taproom lever
//   Cost of goods sold     P&L: holds its recent share of revenue
//                          cash flow: recent purchases × brewing pace
//   Payroll                recent average
//   Depreciation           last month's figure (straight-line)
//   Excise                 recent average × shipments
//   Card fees              recent average × taproom sales
//   Everything else        last month if it barely moves, else the recent average
//
// "Recent" is the last three ENDED months — the open month is partial and
// would read as a collapse.
//
// Pure and client-safe. It only ever ADDS month keys to copies of the rows it
// is given; a month that has happened is returned exactly as it arrived.

import type { CoaAccountRef, FinancialsRow } from "@/lib/finance/financials/types";
import { addMonths, daysBetween, monthBounds, projectShipments } from "./drawdown";
import { DRAWDOWN_CHANNELS, type DrawdownChannel, type ForecastAssumptions, type ForecastDrivers, type ForecastResult } from "./types";

const TRAILING_WINDOW = 3;
const PL_SECTIONS: ReadonlySet<string> = new Set(["revenue", "other_income", "cogs", "expenses", "other_expense"]);
/** A line whose recent months sit within this share of their mean is treated as a fixed cost. */
const STEADY_TOLERANCE = 0.05;

/** Which drawdown channel a statement channel's invoiced beer leaves through. */
const INVOICE_CHANNEL: Partial<Record<FinancialsRow["channel"], DrawdownChannel>> = {
  contract_brewing: "contract_brewing",
  distribution: "distribution",
  wholesale: "distribution",
};

/** Identity of a line for the "how was this forecast" lookup. `channel` "*" is the whole account. */
export function methodKey(row: Pick<FinancialsRow, "coaId" | "accountName">, channel: string): string {
  return `${row.coaId ?? `unmapped:${row.accountName}`}|${channel}`;
}

function pct(value: number): number {
  return 1 + value / 100;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/** The last three ended months that carry any activity at all. */
export function trailingMonthsOf(rows: FinancialsRow[], months: string[], openMonth: string): string[] {
  const active = months.filter(
    (m) => m < openMonth && rows.some((r) => PL_SECTIONS.has(r.statementSection) && (r.amountCentsByMonth[m] ?? 0) !== 0),
  );
  return active.slice(-TRAILING_WINDOW);
}

export interface BuildForecastInput {
  rows: FinancialsRow[];
  months: string[];
  coaAccounts: CoaAccountRef[];
  statement: "pl" | "cash_flow";
  drivers: ForecastDrivers;
  assumptions: ForecastAssumptions;
}

/** Null when there is not a single ended month to extrapolate from. */
export function buildForecast(input: BuildForecastInput): ForecastResult | null {
  const { rows, months, coaAccounts, statement, drivers, assumptions: a } = input;
  const { openMonth } = drivers;

  const trailing = trailingMonthsOf(rows, months, openMonth);
  if (trailing.length === 0) return null;
  const lastTrailing = trailing[trailing.length - 1];

  const forecastMonths = Array.from({ length: a.horizonMonths }, (_, i) => addMonths(openMonth, i + 1));

  // ── Volume ────────────────────────────────────────────────────────────────
  const projected = projectShipments(drivers, forecastMonths, a);
  const recentShipped = (c: DrawdownChannel) => mean(trailing.map((m) => drivers.shippedBblByMonth[c][m] ?? 0));
  /** Projected ÷ recent shipments for a channel; 1 where there is no recent volume to compare against. */
  const volumeFactor = (c: DrawdownChannel, m: string): number => {
    const recent = recentShipped(c);
    return recent > 0 ? projected[c][m] / recent : 1;
  };
  const recentShippedAll = DRAWDOWN_CHANNELS.reduce((sum, c) => sum + recentShipped(c), 0);
  const shippedBblByMonth: Record<string, number> = {};
  for (const m of forecastMonths) shippedBblByMonth[m] = DRAWDOWN_CHANNELS.reduce((sum, c) => sum + projected[c][m], 0);
  const allVolumeFactor = (m: string) => (recentShippedAll > 0 ? shippedBblByMonth[m] / recentShippedAll : 1);

  const pausedShare = (c: DrawdownChannel): number =>
    Math.min(
      1,
      drivers.partners.filter((p) => a.pausedPartnerIds.includes(p.id)).reduce((sum, p) => sum + (p.shareByChannel[c] ?? 0), 0),
    );
  const priceFactor = (c: DrawdownChannel): number =>
    c === "contract_brewing" ? pct(a.contractPricePct) : c === "distribution" ? pct(a.distributionPricePct) : 1;

  const taproomFactor = (monthIndex: number) => Math.pow(pct(a.taproomGrowthPctPerMonth), monthIndex + 1);
  const brewPaceFactor =
    drivers.brewPaceBblPerMonth > 0 && a.brewBblPerMonth !== null ? a.brewBblPerMonth / drivers.brewPaceBblPerMonth : 1;

  // ── Line identity ─────────────────────────────────────────────────────────
  const payroll = new Set(drivers.payrollCoaIds);
  const exciseCoaId = coaAccounts.find((c) => c.accountNumber === drivers.exciseAccountNumber)?.id ?? null;

  const avgOf = (row: FinancialsRow) => mean(trailing.map((m) => row.amountCentsByMonth[m] ?? 0));
  const isSteady = (row: FinancialsRow): boolean => {
    const values = trailing.map((m) => row.amountCentsByMonth[m] ?? 0);
    if (values.length < 2 || values.some((v) => v === 0)) return false;
    const avg = Math.abs(mean(values));
    return Math.max(...values) - Math.min(...values) <= avg * STEADY_TOLERANCE;
  };

  const forecastByRow: number[][] = rows.map(() => forecastMonths.map(() => 0));
  const methodByRow: string[] = rows.map(() => "");
  const cogsRows: number[] = [];

  // Pass 1: every line that does not depend on total revenue.
  rows.forEach((row, i) => {
    const avg = avgOf(row);
    const set = (method: string, value: (m: string, monthIndex: number) => number) => {
      methodByRow[i] = method;
      forecastByRow[i] = forecastMonths.map((m, k) => value(m, k));
    };

    if (!PL_SECTIONS.has(row.statementSection)) return set("Not forecast", () => 0);
    if (row.coaId && payroll.has(row.coaId)) return set("Payroll: recent average", () => avg * pct(a.payrollPct));
    if (row.sourceRef.table === "depreciation_schedules") {
      return set("Depreciation: last month's figure", () => row.amountCentsByMonth[lastTrailing] ?? 0);
    }
    if (exciseCoaId && row.coaId === exciseCoaId) return set("Excise: recent average × projected shipments", (m) => avg * allVolumeFactor(m));
    if (row.sourceRef.table === "square_payment_fees") return set("Card fees: recent average × taproom sales", (_m, k) => avg * taproomFactor(k));

    if (row.statementSection === "revenue") {
      const channel = INVOICE_CHANNEL[row.channel];
      if (channel) {
        const lever = priceFactor(channel) * (1 - pausedShare(channel));
        return set("Drawdown: recent revenue × projected shipments", (m) => avg * volumeFactor(channel, m) * lever);
      }
      if (row.channel === "taproom") return set("Taproom: recent average", (_m, k) => avg * taproomFactor(k));
      // Events are lumpy and refunds/discounts carry no channel: neither has a
      // lever, so both simply repeat their recent average.
      return set("Recent average", () => avg);
    }

    if (row.statementSection === "cogs") {
      if (statement === "cash_flow") {
        return set("Purchases: recent average × brewing pace", () => avg * brewPaceFactor * pct(a.ingredientCostPct));
      }
      cogsRows.push(i);
      return;
    }

    if (row.statementSection === "expenses") {
      return isSteady(row)
        ? set("Fixed cost: last month's amount", () => (row.amountCentsByMonth[lastTrailing] ?? 0) * pct(a.otherOpexPct))
        : set("Recent average", () => avg * pct(a.otherOpexPct));
    }

    return set("Recent average", () => avg);
  });

  // Pass 2: P&L cost of goods holds its recent share of revenue.
  const revenueIdx = rows.map((r, i) => (r.statementSection === "revenue" ? i : -1)).filter((i) => i >= 0);
  const recentRevenue = revenueIdx.reduce((sum, i) => sum + avgOf(rows[i]), 0);
  for (const i of cogsRows) {
    const avg = avgOf(rows[i]);
    methodByRow[i] = "Cost of goods: recent share of revenue";
    forecastByRow[i] = forecastMonths.map((_m, k) => {
      const revenue = revenueIdx.reduce((sum, r) => sum + forecastByRow[r][k], 0);
      const factor = recentRevenue !== 0 ? revenue / recentRevenue : 1;
      return avg * factor * pct(a.ingredientCostPct);
    });
  }

  // Cash flow only: slower collection pushes part of each month's invoiced
  // cash into the next one.
  if (statement === "cash_flow" && a.extraDaysToCollect > 0) {
    const slipped = Math.min(1, a.extraDaysToCollect / 30);
    rows.forEach((row, i) => {
      if (row.statementSection !== "revenue" || !INVOICE_CHANNEL[row.channel]) return;
      const billed = forecastByRow[i];
      const before = avgOf(row);
      forecastByRow[i] = billed.map((v, k) => (1 - slipped) * v + slipped * (k === 0 ? before : billed[k - 1]));
    });
  }

  // ── Assemble ──────────────────────────────────────────────────────────────
  const zeroBbl = Object.fromEntries(forecastMonths.map((m) => [m, 0]));
  const merged: FinancialsRow[] = rows.map((row, i) => ({
    ...row,
    amountCentsByMonth: {
      ...row.amountCentsByMonth,
      ...Object.fromEntries(forecastMonths.map((m, k) => [m, Math.round(forecastByRow[i][k]) || 0])),
    },
    bblByMonth: { ...row.bblByMonth, ...zeroBbl },
  }));

  const methodByKey: Record<string, string> = {};
  const note = (key: string, method: string) => {
    methodByKey[key] = methodByKey[key] && methodByKey[key] !== method ? "Several methods — expand the account" : method;
  };
  rows.forEach((row, i) => {
    note(methodKey(row, row.channel), methodByRow[i]);
    note(methodKey(row, "*"), methodByRow[i]);
  });

  // Scenario lines: costs (or income) the reader typed in. Unmapped on purpose
  // so they can never be mistaken for a real account.
  for (const item of a.items) {
    if (!item.label.trim() || item.amountCents === 0) continue;
    const row: FinancialsRow = {
      coaId: null,
      parentId: null,
      accountName: `Scenario: ${item.label.trim()}`,
      statementSection: "expenses",
      channel: "unknown",
      posCategory: null,
      kegSize: null,
      amountCentsByMonth: {
        ...Object.fromEntries(months.map((m) => [m, 0])),
        ...Object.fromEntries(
          forecastMonths.map((m) => [m, (item.recurring ? m >= item.startMonth : m === item.startMonth) ? 0 - item.amountCents : 0]),
        ),
      },
      bblByMonth: { ...Object.fromEntries(months.map((m) => [m, 0])), ...zeroBbl },
      bblCoverage: "full",
      mappingSource: "manual",
      sourceRef: { table: "forecast_scenario" },
    };
    merged.push(row);
    note(methodKey(row, row.channel), "Scenario line you added");
    note(methodKey(row, "*"), "Scenario line you added");
  }

  const revenueCentsByMonth: Record<string, number> = {};
  const netCentsByMonth: Record<string, number> = {};
  for (const m of forecastMonths) {
    revenueCentsByMonth[m] = 0;
    netCentsByMonth[m] = 0;
    for (const row of merged) {
      if (!PL_SECTIONS.has(row.statementSection)) continue;
      const cents = row.amountCentsByMonth[m] ?? 0;
      netCentsByMonth[m] += cents;
      if (row.statementSection === "revenue") revenueCentsByMonth[m] += cents;
    }
  }

  // Projected cash: today's cash, plus the rest of the open month at the first
  // forecast month's rate, plus each forecast month's net operating cash.
  let cashEndCentsByMonth: Record<string, number> | null = null;
  if (statement === "cash_flow" && drivers.cashOnHandCents !== null) {
    const open = monthBounds(openMonth);
    const daysInOpen = daysBetween(open.start, open.end);
    const daysLeft = Math.max(0, daysBetween(drivers.asOf, open.end) - 1);
    let cash = drivers.cashOnHandCents + (netCentsByMonth[forecastMonths[0]] * daysLeft) / daysInOpen;
    cashEndCentsByMonth = {};
    for (const m of forecastMonths) {
      cash += netCentsByMonth[m];
      cashEndCentsByMonth[m] = Math.round(cash);
    }
  }

  return { trailingMonths: trailing, forecastMonths, rows: merged, methodByKey, revenueCentsByMonth, netCentsByMonth, shippedBblByMonth, cashEndCentsByMonth };
}
