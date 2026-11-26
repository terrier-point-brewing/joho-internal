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
//   Bills spread over      P&L: their own monthly schedule, then the same
//   several months         monthly share, assuming the bill renews
//                          cash flow: the whole bill, when it next falls due
//   Everything else        last month if it barely moves, else the recent average
//
// "Recent" is the last three ENDED months — the open month is partial and
// would read as a collapse.
//
// The open month gets its own projection: what is still to come before month
// end. Lines that flow daily (taproom, card fees) are pro-rated over the days
// left; beer on invoice follows the shipments still due this month; everything
// else is a bill, which "catches up" to its expected monthly amount — rent
// already paid adds nothing, payroll half-paid adds the other half.
//
// Pure and client-safe. It only ever ADDS month keys to copies of the rows it
// is given; a month that has happened is returned exactly as it arrived.

import type { CoaAccountRef, FinancialsRow } from "@/lib/finance/financials/types";
import { addMonths, daysBetween, monthBounds, projectShipments } from "./drawdown";
import { SERVICE_PERIOD_TABLE } from "@/lib/finance/servicePeriod";
import {
  DRAWDOWN_CHANNELS,
  type CashOutlook,
  type DrawdownChannel,
  type ForecastAssumptions,
  type ForecastDrivers,
  type ForecastResult,
} from "./types";

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

/** The key a row carries the rest of the open month under. Never a real month, so no actual can collide with it. */
export function restKeyOf(month: string): string {
  return `${month}:rest`;
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

  // ── The open month ────────────────────────────────────────────────────────
  const hasOpen = months.includes(openMonth);
  const restKey = hasOpen ? restKeyOf(openMonth) : null;
  const openBounds = monthBounds(openMonth);
  const daysInOpen = daysBetween(openBounds.start, openBounds.end);
  // Today's activity is already in the actuals, so today is not a day "left".
  const daysLeft = hasOpen ? Math.max(0, daysBetween(drivers.asOf, openBounds.end) - 1) : 0;
  const restShare = daysLeft / daysInOpen;
  const proRata = (expected: number) => expected * restShare;
  /** What a bill still owes this month: the gap up to its expected amount, never a reversal. */
  const catchUp = (row: FinancialsRow, expected: number): number => {
    if (daysLeft === 0 || expected === 0) return 0;
    const actual = row.amountCentsByMonth[openMonth] ?? 0;
    if (actual === 0) return expected;
    if (Math.sign(actual) !== Math.sign(expected) || Math.abs(actual) >= Math.abs(expected)) return 0;
    return expected - actual;
  };

  // ── Volume ────────────────────────────────────────────────────────────────
  // The open month is projected alongside the forecast months: for it,
  // projectShipments only counts what leaves after today.
  const projected = projectShipments(drivers, [openMonth, ...forecastMonths], a);
  const recentShipped = (c: DrawdownChannel) => mean(trailing.map((m) => drivers.shippedBblByMonth[c][m] ?? 0));
  /** Projected ÷ recent shipments for a channel; 1 where there is no recent volume to compare against. */
  const volumeFactor = (c: DrawdownChannel, m: string): number => {
    const recent = recentShipped(c);
    return recent > 0 ? projected[c][m] / recent : 1;
  };
  const recentShippedAll = DRAWDOWN_CHANNELS.reduce((sum, c) => sum + recentShipped(c), 0);
  const shippedBblByMonth: Record<string, number> = {};
  for (const m of [openMonth, ...forecastMonths]) shippedBblByMonth[m] = DRAWDOWN_CHANNELS.reduce((sum, c) => sum + projected[c][m], 0);
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

  // ── Bills spread over the months they cover ───────────────────────────────
  // Read from their schedule, never from history: a yearly bill is one large
  // month (its catch-up, or the month it was paid), and an average would smear
  // that across every month after it. `?? []` because a browser can hold a
  // drivers payload cached from before the field existed.
  const spreadBills = drivers.spreadBills ?? [];
  const monthIndex = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7));
  /**
   * A bill is assumed to renew at the same price unless a later bill on the
   * same account has already replaced it. Two unrelated bills on one account
   * read as a renewal of each other once either is replaced, which understates
   * that account until the second is replaced too — the cautious direction for
   * a guess about a bill that does not exist yet.
   */
  const renews = (bill: (typeof spreadBills)[number]) =>
    !spreadBills.some((other) => other.coaId === bill.coaId && other.periodStartMonth > bill.periodEndMonth);
  /** P&L: the scheduled share while the bill runs, then one month's share for as long as it is assumed to renew. */
  const spreadAccrual = (coaId: string | null, m: string): number =>
    spreadBills
      .filter((b) => b.coaId === coaId)
      .reduce((sum, b) => {
        const scheduled = b.recognitionCentsByMonth[m];
        if (scheduled !== undefined) return sum + scheduled;
        return m > b.periodEndMonth && renews(b) ? sum + b.monthlyCents : sum;
      }, 0);
  /** Cash flow: the whole bill again, one period after it was last paid. */
  const spreadCash = (coaId: string | null, m: string): number =>
    spreadBills
      .filter((b) => b.coaId === coaId && b.paidMonth !== null && renews(b))
      .reduce((sum, b) => {
        const gap = monthIndex(m) - monthIndex(b.paidMonth!);
        return gap > 0 && gap % b.periodMonths === 0 ? sum + b.amountCents : sum;
      }, 0);

  const forecastByRow: number[][] = rows.map(() => forecastMonths.map(() => 0));
  /** Still to come in the open month, per row. */
  const restByRow: number[] = rows.map(() => 0);
  const methodByRow: string[] = rows.map(() => "");
  const cogsRows: number[] = [];

  // Pass 1: every line that does not depend on total revenue.
  rows.forEach((row, i) => {
    const avg = avgOf(row);
    const last = row.amountCentsByMonth[lastTrailing] ?? 0;
    // `rest` is the open month's remainder. A bill catches up to its UNLEVERED
    // expected amount: a lever describes the months ahead, and applying it to
    // a whole month's bill in the last few days would overstate it.
    const set = (method: string, value: (m: string, monthIndex: number) => number, rest: number) => {
      methodByRow[i] = method;
      forecastByRow[i] = forecastMonths.map((m, k) => value(m, k));
      restByRow[i] = hasOpen ? rest : 0;
    };

    if (!PL_SECTIONS.has(row.statementSection)) return set("Not forecast", () => 0, 0);
    if (row.coaId && payroll.has(row.coaId)) return set("Payroll: recent average", () => avg * pct(a.payrollPct), catchUp(row, avg));
    if (row.sourceRef.table === "depreciation_schedules") {
      return set("Depreciation: last month's figure", () => last, catchUp(row, last));
    }
    // Nothing more this month either way: the open month's share is booked in
    // full the day the month starts, and a paid bill is not paid twice.
    if (row.sourceRef.table === SERVICE_PERIOD_TABLE) {
      return statement === "cash_flow"
        ? set("Bill covering several months: the whole bill, when it next falls due", (m) => spreadCash(row.coaId, m), 0)
        : set("Bill covering several months: one month's share, assuming it renews at the same price", (m) => spreadAccrual(row.coaId, m), 0);
    }
    if (exciseCoaId && row.coaId === exciseCoaId) {
      return set(
        "Excise: recent average × projected shipments",
        (m) => avg * allVolumeFactor(m),
        recentShippedAll > 0 ? avg * allVolumeFactor(openMonth) : proRata(avg),
      );
    }
    if (row.sourceRef.table === "square_payment_fees") {
      return set("Card fees: recent average × taproom sales", (_m, k) => avg * taproomFactor(k), proRata(avg));
    }

    if (row.statementSection === "revenue") {
      const channel = INVOICE_CHANNEL[row.channel];
      if (channel) {
        const lever = priceFactor(channel) * (1 - pausedShare(channel));
        return set(
          "Drawdown: recent revenue × projected shipments",
          (m) => avg * volumeFactor(channel, m) * lever,
          recentShipped(channel) > 0 ? avg * volumeFactor(channel, openMonth) * lever : proRata(avg * lever),
        );
      }
      if (row.channel === "taproom") return set("Taproom: recent average", (_m, k) => avg * taproomFactor(k), proRata(avg));
      // Events are lumpy and refunds/discounts carry no channel: neither has a
      // lever, so both simply repeat their recent average.
      return set("Recent average", () => avg, catchUp(row, avg));
    }

    if (row.statementSection === "cogs") {
      if (statement === "cash_flow") {
        return set("Purchases: recent average × brewing pace", () => avg * brewPaceFactor * pct(a.ingredientCostPct), catchUp(row, avg));
      }
      cogsRows.push(i);
      return;
    }

    if (row.statementSection === "expenses") {
      return isSteady(row)
        ? set("Fixed cost: last month's amount", () => last * pct(a.otherOpexPct), catchUp(row, last))
        : set("Recent average", () => avg * pct(a.otherOpexPct), catchUp(row, avg));
    }

    return set("Recent average", () => avg, catchUp(row, avg));
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
    // The rest of the open month costs its share of the revenue still to come.
    const restRevenue = revenueIdx.reduce((sum, r) => sum + restByRow[r], 0);
    restByRow[i] = hasOpen ? (recentRevenue !== 0 ? avg * (restRevenue / recentRevenue) : proRata(avg)) : 0;
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
  // Every key the forecast adds to a row, in column order.
  const addedKeys = [...(restKey ? [restKey] : []), ...forecastMonths];
  const zeroBbl = Object.fromEntries(addedKeys.map((m) => [m, 0]));
  const merged: FinancialsRow[] = rows.map((row, i) => ({
    ...row,
    amountCentsByMonth: {
      ...row.amountCentsByMonth,
      ...(restKey ? { [restKey]: Math.round(restByRow[i]) || 0 } : {}),
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
        ...(restKey ? { [restKey]: 0 } : {}),
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
  for (const m of addedKeys) {
    revenueCentsByMonth[m] = 0;
    netCentsByMonth[m] = 0;
    for (const row of merged) {
      if (!PL_SECTIONS.has(row.statementSection)) continue;
      const cents = row.amountCentsByMonth[m] ?? 0;
      netCentsByMonth[m] += cents;
      if (row.statementSection === "revenue") revenueCentsByMonth[m] += cents;
    }
  }

  // Projected cash: today's cash, plus what is still to come this month, plus
  // each forecast month's net operating cash.
  let cashEndCentsByMonth: Record<string, number> | null = null;
  let cashRow: FinancialsRow | null = null;
  if (statement === "cash_flow" && drivers.cashOnHandCents !== null) {
    let cash = drivers.cashOnHandCents + (restKey ? netCentsByMonth[restKey] : 0);
    cashEndCentsByMonth = {};
    if (hasOpen) cashEndCentsByMonth[openMonth] = Math.round(cash);
    for (const m of forecastMonths) {
      cash += netCentsByMonth[m];
      cashEndCentsByMonth[m] = Math.round(cash);
    }
    // A balance, not a flow: the open month's own cell is today's cash and its
    // rest-of-month cell is the month-end figure, exactly as on the balance sheet.
    cashRow = {
      coaId: null,
      parentId: null,
      accountName: "Projected cash",
      statementSection: "other",
      channel: "unknown",
      posCategory: null,
      kegSize: null,
      amountCentsByMonth: {
        ...Object.fromEntries(months.map((m) => [m, m === openMonth ? drivers.cashOnHandCents ?? 0 : 0])),
        ...(restKey ? { [restKey]: cashEndCentsByMonth[openMonth] } : {}),
        ...Object.fromEntries(forecastMonths.map((m) => [m, cashEndCentsByMonth![m]])),
      },
      bblByMonth: { ...Object.fromEntries(months.map((m) => [m, 0])), ...zeroBbl },
      bblCoverage: "full",
      mappingSource: "rule",
      sourceRef: { table: "forecast_cash" },
    };
    note(methodKey(cashRow, cashRow.channel), "Cash today + forecast net operating cash. Loans, owner draws and equipment purchases are not included unless you add them as items.");
  }

  return {
    trailingMonths: trailing,
    openMonth,
    restKey,
    daysLeftInOpenMonth: daysLeft,
    forecastMonths,
    rows: merged,
    methodByKey,
    revenueCentsByMonth,
    netCentsByMonth,
    shippedBblByMonth,
    cashEndCentsByMonth,
    cashRow,
  };
}

/** Revenue and net (income or operating cash) per actual month, summed exactly as the forecast's own headline figures are. */
export function actualsByMonth(rows: FinancialsRow[], months: string[]): { revenue: Record<string, number>; net: Record<string, number> } {
  const revenue: Record<string, number> = {};
  const net: Record<string, number> = {};
  for (const m of months) {
    revenue[m] = 0;
    net[m] = 0;
    for (const row of rows) {
      if (!PL_SECTIONS.has(row.statementSection)) continue;
      const cents = row.amountCentsByMonth[m] ?? 0;
      net[m] += cents;
      if (row.statementSection === "revenue") revenue[m] += cents;
    }
  }
  return { revenue, net };
}

// ── Cash outlook ────────────────────────────────────────────────────────────

/** The runway headline of a cash-flow forecast. Null when the forecast carries no cash projection. */
export function cashOutlook(result: ForecastResult, cashOnHandCents: number | null): CashOutlook | null {
  const cash = result.cashEndCentsByMonth;
  if (!cash || cashOnHandCents === null || result.forecastMonths.length === 0) return null;
  const points = [...(result.restKey ? [result.openMonth] : []), ...result.forecastMonths];
  const endMonth = points[points.length - 1];
  let lowMonth = points[0];
  for (const m of points) if (cash[m] < cash[lowMonth]) lowMonth = m;
  const avgNet = result.forecastMonths.reduce((sum, m) => sum + result.netCentsByMonth[m], 0) / result.forecastMonths.length;
  return {
    todayCents: cashOnHandCents,
    endMonth,
    endCents: cash[endMonth],
    lowMonth,
    lowCents: cash[lowMonth],
    runsOutMonth: points.find((m) => cash[m] < 0) ?? null,
    runwayMonthsAfter: avgNet < 0 && cash[endMonth] > 0 ? cash[endMonth] / -avgNet : null,
  };
}

// ── Balance sheet ───────────────────────────────────────────────────────────

/** Where forecast activity lands on the balance sheet. */
const ACCUMULATED_DEPRECIATION_ACCOUNT = "1590";
const RETAINED_EARNINGS_ACCOUNT = "3300";

export interface BalanceSheetForecastInput {
  rows: FinancialsRow[];
  months: string[];
  coaAccounts: CoaAccountRef[];
  /** The P&L and cash-flow forecasts for the SAME assumptions. */
  pl: ForecastResult;
  cashFlow: ForecastResult;
}

/**
 * The balance sheet rolled forward from the other two forecasts, so the three
 * statements agree by construction:
 *
 *   Cash                      + forecast net operating cash  (largest bank account)
 *   Accumulated depreciation  + forecast depreciation
 *   Retained earnings         + forecast net income
 *   Everything else           held at its latest balance
 *
 * Profit and cash never move by the same amount — an invoice raised is not an
 * invoice paid — and that difference has to sit somewhere or the sheet stops
 * balancing. It is shown as one honest line, "Forecast timing differences",
 * rather than guessed across receivables, payables and inventory. The
 * Balancing Difference therefore stays exactly what it is today.
 *
 * Rows are in the internal sign convention (assets positive, liabilities and
 * equity negative), which is what buildTree expects.
 */
export function buildBalanceSheetForecast(input: BalanceSheetForecastInput): ForecastResult | null {
  const { rows, months, coaAccounts, pl, cashFlow } = input;
  if (rows.length === 0 || months.length === 0) return null;
  const lastMonth = months[months.length - 1];
  const restKey = months.includes(pl.openMonth) ? restKeyOf(pl.openMonth) : null;
  const keys = [...(restKey ? [restKey] : []), ...pl.forecastMonths];

  // Cumulative movement since today, per added key.
  const running = (by: (key: string) => number): Record<string, number> => {
    let total = 0;
    return Object.fromEntries(keys.map((k) => [k, (total += by(k))]));
  };
  // Both statements key the rest of the open month the same way, and one that
  // does not show the open month simply carries no figure for it.
  const cumCash = running((k) => cashFlow.netCentsByMonth[k] ?? 0);
  const cumNet = running((k) => pl.netCentsByMonth[k] ?? 0);
  const cumDepreciation = running((k) =>
    pl.rows.filter((r) => r.sourceRef.table === "depreciation_schedules").reduce((sum, r) => sum + (r.amountCentsByMonth[k] ?? 0), 0),
  );

  const coaIdOf = (accountNumber: string) => coaAccounts.find((c) => c.accountNumber === accountNumber)?.id ?? null;
  const indexOfAccount = (accountNumber: string) => {
    const id = coaIdOf(accountNumber);
    return id ? rows.findIndex((r) => r.coaId === id) : -1;
  };
  const bankIdx = rows
    .map((r, i) => ({ i, size: r.statementSection === "bank" ? Math.abs(r.amountCentsByMonth[lastMonth] ?? 0) : -1 }))
    .filter((x) => x.size >= 0)
    .sort((x, y) => y.size - x.size)[0]?.i ?? -1;
  const depreciationIdx = indexOfAccount(ACCUMULATED_DEPRECIATION_ACCOUNT);
  const earningsIdx = indexOfAccount(RETAINED_EARNINGS_ACCOUNT);

  const movements: { index: number; section: string; label: string; method: string; delta: Record<string, number> }[] = [
    { index: bankIdx, section: "bank", label: "Forecast: cash movement", method: "Cash: latest balance + forecast net operating cash", delta: cumCash },
    { index: depreciationIdx, section: "fixed_assets", label: "Forecast: depreciation", method: "Accumulated depreciation: latest balance + forecast depreciation", delta: cumDepreciation },
    // Equity is stored negative, so a profit makes it more negative.
    { index: earningsIdx, section: "equity", label: "Forecast: earnings", method: "Retained earnings: latest balance + forecast net income", delta: Object.fromEntries(keys.map((k) => [k, 0 - cumNet[k]])) },
  ];

  const methodByKey: Record<string, string> = {};
  const held = (row: FinancialsRow) => Object.fromEntries(keys.map((k) => [k, row.amountCentsByMonth[lastMonth] ?? 0]));
  const zeroBbl = Object.fromEntries(keys.map((k) => [k, 0]));
  const merged: FinancialsRow[] = rows.map((row) => {
    methodByKey[methodKey(row, row.channel)] = methodByKey[methodKey(row, "*")] = "Held at the latest balance";
    return { ...row, amountCentsByMonth: { ...row.amountCentsByMonth, ...held(row) }, bblByMonth: { ...row.bblByMonth, ...zeroBbl } };
  });

  const synthetic = (section: string, label: string, method: string, delta: Record<string, number>): void => {
    const row: FinancialsRow = {
      coaId: null,
      parentId: null,
      accountName: label,
      statementSection: section,
      channel: "unknown",
      posCategory: null,
      kegSize: null,
      amountCentsByMonth: { ...Object.fromEntries(months.map((m) => [m, 0])), ...Object.fromEntries(keys.map((k) => [k, Math.round(delta[k]) || 0])) },
      bblByMonth: { ...Object.fromEntries(months.map((m) => [m, 0])), ...zeroBbl },
      bblCoverage: "full",
      mappingSource: "manual",
      sourceRef: { table: "forecast_scenario" },
    };
    merged.push(row);
    methodByKey[methodKey(row, row.channel)] = methodByKey[methodKey(row, "*")] = method;
  };

  for (const mv of movements) {
    if (mv.index < 0) {
      // The account carries no balance yet, so there is no line to move.
      synthetic(mv.section, mv.label, mv.method, mv.delta);
      continue;
    }
    const row = merged[mv.index];
    for (const k of keys) row.amountCentsByMonth[k] += Math.round(mv.delta[k]) || 0;
    methodByKey[methodKey(row, row.channel)] = methodByKey[methodKey(row, "*")] = mv.method;
  }

  // Whatever the three movements leave unbalanced: profit earned but not yet
  // collected (or cash paid for costs not yet expensed). An asset when positive.
  synthetic(
    "other_current_assets",
    "Forecast: timing differences",
    "Forecast profit not yet collected, less costs not yet paid — the gap between forecast net income and forecast cash",
    Object.fromEntries(keys.map((k) => [k, 0 - movements.reduce((sum, mv) => sum + (Math.round(mv.delta[k]) || 0), 0)])),
  );

  return {
    trailingMonths: pl.trailingMonths,
    openMonth: pl.openMonth,
    restKey,
    daysLeftInOpenMonth: pl.daysLeftInOpenMonth,
    forecastMonths: pl.forecastMonths,
    rows: merged,
    methodByKey,
    revenueCentsByMonth: {},
    netCentsByMonth: {},
    shippedBblByMonth: {},
    cashEndCentsByMonth: null,
    cashRow: null,
  };
}
