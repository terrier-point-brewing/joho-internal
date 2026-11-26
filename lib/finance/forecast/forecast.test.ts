import { describe, expect, it } from "vitest";
import type { CoaAccountRef, FinancialsRow } from "@/lib/finance/financials/types";
import { actualsByMonth, buildBalanceSheetForecast, buildForecast, cashOutlook, methodKey, restKeyOf, trailingMonthsOf } from "./forecast";
import { BASE_ASSUMPTIONS, type ForecastAssumptions, type ForecastDrivers, type ForecastSpreadBill } from "./types";
import { SERVICE_PERIOD_TABLE } from "@/lib/finance/servicePeriod";

const MONTHS = ["2026-07", "2026-08", "2026-09", "2026-10", "2026-11"];

function row(over: Partial<FinancialsRow> & { amounts: number[] }): FinancialsRow {
  const { amounts, ...rest } = over;
  return {
    coaId: "x",
    parentId: null,
    accountName: "X",
    statementSection: "expenses",
    channel: "unknown",
    posCategory: null,
    kegSize: null,
    amountCentsByMonth: Object.fromEntries(MONTHS.map((m, i) => [m, amounts[i] ?? 0])),
    bblByMonth: {},
    bblCoverage: "full",
    mappingSource: "rule",
    sourceRef: { table: "expenses" },
    ...rest,
  };
}

// Recent months (Aug–Oct) are the basis; July is too old and November is open.
const ROWS: FinancialsRow[] = [
  row({ coaId: "contract", accountName: "Contract Revenue", statementSection: "revenue", channel: "contract_brewing", amounts: [1, 10_000, 10_000, 10_000, 500], sourceRef: { table: "invoice_line_items" } }),
  row({ coaId: "taproom", accountName: "Taproom Sales", statementSection: "revenue", channel: "taproom", amounts: [1, 20_000, 20_000, 20_000, 900], sourceRef: { table: "pos_line_items" } }),
  row({ coaId: "cogs", accountName: "Ingredients", statementSection: "cogs", amounts: [0, -9_000, -9_000, -9_000, -100] }),
  row({ coaId: "wages", accountName: "Wages", amounts: [0, -5_000, -6_000, -7_000, -100] }),
  row({ coaId: "rent", accountName: "Rent", amounts: [0, -4_000, -4_000, -4_100, 0] }),
  row({ coaId: "supplies", accountName: "Supplies", amounts: [0, -100, -900, -200, 0] }),
  row({ coaId: "depr", accountName: "Depreciation", statementSection: "other_expense", amounts: [0, -300, -300, -350, 0], sourceRef: { table: "depreciation_schedules" } }),
  row({ coaId: "excise", accountName: "Excise", amounts: [0, -600, -600, -600, 0], sourceRef: { table: "export_transaction_taxes" } }),
  row({ coaId: "deposit", accountName: "Customer Deposits", statementSection: "other_current_liabilities", amounts: [0, 5_000, 5_000, 5_000, 0] }),
];

const COA: CoaAccountRef[] = [{ id: "excise", parentId: null, accountName: "Excise", accountNumber: "6451", statementSection: "expenses" }];

const REST = restKeyOf("2026-11");
const FLAT = [0, 0.25, 0.5, 0.75, 1];
const DRIVERS: ForecastDrivers = {
  asOf: "2026-11-25",
  openMonth: "2026-11",
  curveStepDays: 7,
  curves: { contract_brewing: FLAT, distribution: FLAT, taproom: FLAT },
  shipFraction: { contract_brewing: 0.5, distribution: 0, taproom: 0 },
  batches: [],
  brewPaceBblPerMonth: 100,
  // 50 bbl a month recently, which is what 100 bbl of brewing at a 0.5 ship fraction sustains.
  shippedBblByMonth: { contract_brewing: { "2026-08": 50, "2026-09": 50, "2026-10": 50 }, distribution: {}, taproom: {} },
  payrollCoaIds: ["wages"],
  exciseAccountNumber: "6451",
  partners: [{ id: "argus", name: "Argus", shareByChannel: { contract_brewing: 0.9 } }],
  cashOnHandCents: 100_000,
  matureBatchCount: 12,
  spreadBills: [],
};

function run(assumptions: Partial<ForecastAssumptions> = {}, statement: "pl" | "cash_flow" = "pl") {
  const result = buildForecast({ rows: ROWS, months: MONTHS, coaAccounts: COA, statement, drivers: DRIVERS, assumptions: { ...BASE_ASSUMPTIONS, ...assumptions } });
  if (!result) throw new Error("expected a forecast");
  const at = (coaId: string, month: string) => result.rows.find((r) => r.coaId === coaId)!.amountCentsByMonth[month];
  return { result, at };
}

describe("trailingMonthsOf", () => {
  it("takes the last three ended months and skips the open one", () => {
    expect(trailingMonthsOf(ROWS, MONTHS, "2026-11")).toEqual(["2026-08", "2026-09", "2026-10"]);
  });
  it("skips months before the business had any activity", () => {
    const young = [row({ statementSection: "revenue", amounts: [0, 0, 0, 500, 100] })];
    expect(trailingMonthsOf(young, MONTHS, "2026-11")).toEqual(["2026-10"]);
    expect(buildForecast({ rows: [row({ amounts: [] })], months: MONTHS, coaAccounts: [], statement: "pl", drivers: DRIVERS, assumptions: BASE_ASSUMPTIONS })).toBeNull();
  });
});

describe("buildForecast", () => {
  it("never changes a month that has happened", () => {
    const { result } = run({ payrollPct: 50, taproomGrowthPctPerMonth: 9 });
    ROWS.forEach((original, i) => {
      for (const m of MONTHS) expect(result.rows[i].amountCentsByMonth[m]).toBe(original.amountCentsByMonth[m]);
    });
    expect(result.forecastMonths).toEqual(["2026-12", "2027-01", "2027-02"]);
    // Every row carries every month, which is what lets buildTree total them.
    for (const r of result.rows) expect(Object.keys(r.amountCentsByMonth)).toEqual([...MONTHS, REST, ...result.forecastMonths]);
  });

  it("forecasts each line by its own method", () => {
    const { result, at } = run();
    const feb = "2027-02";
    expect(at("taproom", feb)).toBe(20_000);
    expect(at("wages", feb)).toBe(-6_000); // payroll: average, even though it is not steady
    expect(at("rent", feb)).toBe(-4_100); // steady: last month's amount
    expect(at("supplies", feb)).toBe(-400); // lumpy: average
    expect(at("depr", feb)).toBe(-350); // last month's figure
    expect(at("deposit", feb)).toBe(0); // a balance-sheet account on the P&L is not forecast
    expect(result.methodByKey[methodKey(ROWS[4], "*")]).toMatch(/Fixed cost/);
    expect(result.methodByKey[methodKey(ROWS[0], "contract_brewing")]).toMatch(/Drawdown/);
  });

  it("scales invoiced beer with projected shipments, and ties to the run-rate at a steady pace", () => {
    const { at, result } = run();
    // By February the weekly brews are in steady state: ~50 bbl a month, as recently.
    expect(at("contract", "2027-02")).toBeGreaterThan(9_000);
    expect(at("contract", "2027-02")).toBeLessThan(11_000);
    expect(result.shippedBblByMonth["2027-02"]).toBeGreaterThan(45);
    const doubled = run({ brewBblPerMonth: 200 });
    expect(doubled.at("contract", "2027-02")).toBeCloseTo(2 * at("contract", "2027-02"), -2);
    // Excise follows the same volume.
    expect(doubled.at("excise", "2027-02")).toBeCloseTo(2 * at("excise", "2027-02"), -1);
  });

  it("holds cost of goods at its recent share of revenue on the P&L", () => {
    const { at } = run({ taproomGrowthPctPerMonth: 10 });
    const feb = "2027-02";
    const revenue = at("contract", feb) + at("taproom", feb);
    expect(at("cogs", feb)).toBeCloseTo(-9_000 * (revenue / 30_000), -1);
    expect(at("taproom", feb)).toBe(Math.round(20_000 * 1.1 ** 3));
  });

  it("ties cash-flow cost of goods to the brewing pace instead", () => {
    const { at } = run({ brewBblPerMonth: 150, ingredientCostPct: 10 }, "cash_flow");
    expect(at("cogs", "2026-12")).toBe(Math.round(-9_000 * 1.5 * 1.1));
  });

  it("applies the price, partner and cost levers", () => {
    const base = run();
    const dec = "2026-12";
    expect(run({ contractPricePct: 10 }).at("contract", dec)).toBeCloseTo(base.at("contract", dec) * 1.1, -1);
    expect(run({ pausedPartnerIds: ["argus"] }).at("contract", dec)).toBeCloseTo(base.at("contract", dec) * 0.1, -1);
    expect(run({ payrollPct: 10 }).at("wages", dec)).toBe(-6_600);
    expect(run({ otherOpexPct: 10 }).at("rent", dec)).toBe(-4_510);
    expect(run({ otherOpexPct: 10 }).at("wages", dec)).toBe(-6_000);
  });

  it("adds scenario lines as their own rows", () => {
    const { result } = run({
      items: [
        { id: "1", label: "Fermenter", amountCents: 50_000, startMonth: "2027-01", recurring: false },
        { id: "2", label: "New lease", amountCents: 2_000, startMonth: "2027-01", recurring: true },
        { id: "3", label: "", amountCents: 9_999, startMonth: "2027-01", recurring: true },
      ],
    });
    const fermenter = result.rows.find((r) => r.accountName === "Scenario: Fermenter")!;
    expect(fermenter.amountCentsByMonth).toMatchObject({ "2026-11": 0, "2026-12": 0, "2027-01": -50_000, "2027-02": 0 });
    const lease = result.rows.find((r) => r.accountName === "Scenario: New lease")!;
    expect(lease.amountCentsByMonth).toMatchObject({ "2026-12": 0, "2027-01": -2_000, "2027-02": -2_000 });
    expect(result.rows).toHaveLength(ROWS.length + 2);
    expect(result.netCentsByMonth["2027-01"]).toBe(run().result.netCentsByMonth["2027-01"] - 52_000);
  });

  it("projects cash on the cash-flow statement only, and slips collections", () => {
    expect(run().result.cashEndCentsByMonth).toBeNull();
    const cf = run({}, "cash_flow");
    const cash = cf.result.cashEndCentsByMonth!;
    const net = cf.result.netCentsByMonth;
    // Today's cash, plus what is still to come this month, plus each month after.
    expect(cash["2026-11"]).toBe(100_000 + net[REST]);
    expect(cash["2026-12"]).toBe(cash["2026-11"] + net["2026-12"]);
    expect(cash["2027-01"]).toBe(cash["2026-12"] + net["2027-01"]);
    // The line the table draws: today's cash in the open month, month-end cash after it.
    const line = cf.result.cashRow!.amountCentsByMonth;
    expect(line).toMatchObject({ "2026-10": 0, "2026-11": 100_000, [REST]: cash["2026-11"], "2027-02": cash["2027-02"] });
    expect(run().result.cashRow).toBeNull();

    const late = run({ extraDaysToCollect: 15 }, "cash_flow");
    // Half of December's invoiced cash is replaced by half of the recent average.
    expect(late.at("contract", "2026-12")).toBe(Math.round(0.5 * cf.at("contract", "2026-12") + 0.5 * 10_000));
    expect(late.at("taproom", "2026-12")).toBe(cf.at("taproom", "2026-12"));
    expect(run({ extraDaysToCollect: 15 }).at("contract", "2026-12")).toBe(run().at("contract", "2026-12"));
  });
});

describe("the open month", () => {
  // 25 November: 5 of the month's 30 days are still to come.
  it("pro-rates what flows daily and lets a bill catch up to its usual amount", () => {
    const { at, result } = run();
    expect(result.restKey).toBe(REST);
    expect(result.daysLeftInOpenMonth).toBe(5);
    expect(at("taproom", REST)).toBe(Math.round((20_000 * 5) / 30));
    expect(at("rent", REST)).toBe(-4_100); // not paid yet this month
    expect(at("wages", REST)).toBe(-5_900); // -100 paid of the usual -6,000
    expect(at("supplies", REST)).toBe(-400);
    expect(at("depr", REST)).toBe(-350);
    // No batch is due to ship before month end, so no more invoiced beer or excise.
    expect(at("contract", REST)).toBe(0);
    expect(at("excise", REST) || 0).toBe(0);
    // Cost of goods follows the revenue still to come.
    expect(at("cogs", REST)).toBe(Math.round(-9_000 * ((20_000 * 5) / 30 / 30_000)));
    expect(at("deposit", REST)).toBe(0);
  });

  it("adds nothing to a bill that has already been paid in full, or more", () => {
    const paid = ROWS.map((r) => (r.coaId === "rent" ? { ...r, amountCentsByMonth: { ...r.amountCentsByMonth, "2026-11": -4_500 } } : r));
    const result = buildForecast({ rows: paid, months: MONTHS, coaAccounts: COA, statement: "pl", drivers: DRIVERS, assumptions: BASE_ASSUMPTIONS })!;
    expect(result.rows.find((r) => r.coaId === "rent")!.amountCentsByMonth[REST]).toBe(0);
  });

  it("does not let a lever inflate a bill that is merely catching up", () => {
    expect(run({ payrollPct: 50 }).at("wages", REST)).toBe(-5_900);
  });

  it("counts beer that ships before month end", () => {
    // Brewed a week ago, shipping evenly over 28 days: 5 more days of it land in November.
    const drivers = { ...DRIVERS, batches: [{ brewDate: "2026-11-18", bbl: 100, shippedBbl: 0 }] };
    const result = buildForecast({ rows: ROWS, months: MONTHS, coaAccounts: COA, statement: "pl", drivers, assumptions: BASE_ASSUMPTIONS })!;
    expect(result.rows.find((r) => r.coaId === "contract")!.amountCentsByMonth[REST]).toBeGreaterThan(0);
    expect(result.shippedBblByMonth["2026-11"]).toBeGreaterThan(0);
  });

  it("has no rest-of-month figure for a statement that does not show the open month", () => {
    const past = MONTHS.slice(0, 4);
    const rows = ROWS.map((r) => ({ ...r, amountCentsByMonth: Object.fromEntries(past.map((m) => [m, r.amountCentsByMonth[m]])) }));
    const result = buildForecast({ rows, months: past, coaAccounts: COA, statement: "cash_flow", drivers: DRIVERS, assumptions: BASE_ASSUMPTIONS })!;
    expect(result.restKey).toBeNull();
    expect(Object.keys(result.rows[0].amountCentsByMonth)).toEqual([...past, ...result.forecastMonths]);
  });
});

describe("cashOutlook", () => {
  it("reports where cash ends, its low point, and how long it lasts", () => {
    const cf = run({}, "cash_flow").result;
    const outlook = cashOutlook(cf, 100_000)!;
    expect(outlook.todayCents).toBe(100_000);
    expect(outlook.endMonth).toBe("2027-02");
    expect(outlook.endCents).toBe(cf.cashEndCentsByMonth!["2027-02"]);
    expect(outlook.runsOutMonth).toBeNull();
    expect(cashOutlook(run().result, 100_000)).toBeNull();
  });

  it("names the month cash runs out", () => {
    const burning = run({ items: [{ id: "1", label: "Big hire", amountCents: 60_000, startMonth: "2026-12", recurring: true }] }, "cash_flow").result;
    const outlook = cashOutlook(burning, 100_000)!;
    expect(outlook.runsOutMonth).toBe(Object.keys(burning.cashEndCentsByMonth!).find((m) => burning.cashEndCentsByMonth![m] < 0));
    expect(outlook.runsOutMonth).not.toBeNull();
    expect(outlook.lowMonth).toBe("2027-02");
  });
});

describe("actualsByMonth", () => {
  it("sums revenue and net exactly as the forecast's headline does", () => {
    const { revenue, net } = actualsByMonth(ROWS, MONTHS);
    expect(revenue["2026-10"]).toBe(30_000);
    // The customer-deposit row is a balance-sheet account and stays out of net.
    expect(net["2026-10"]).toBe(30_000 - 9_000 - 7_000 - 4_100 - 200 - 350 - 600);
  });
});

describe("buildBalanceSheetForecast", () => {
  // Internal signs: assets positive, liabilities and equity negative; it balances today.
  const balance = (over: Partial<FinancialsRow> & { latest: number }): FinancialsRow => {
    const { latest, ...rest } = over;
    return row({ ...rest, amounts: [latest, latest, latest, latest, latest], sourceRef: { table: "gl_account_balances" } });
  };
  const BS_ROWS: FinancialsRow[] = [
    balance({ coaId: "checking", accountName: "Checking", statementSection: "bank", latest: 90_000 }),
    balance({ coaId: "savings", accountName: "Savings", statementSection: "bank", latest: 10_000 }),
    balance({ coaId: "equipment", accountName: "Equipment", statementSection: "fixed_assets", latest: 50_000 }),
    balance({ coaId: "accum", accountName: "Accumulated Depreciation", statementSection: "fixed_assets", latest: -5_000 }),
    balance({ coaId: "payables", accountName: "Payables", statementSection: "ap", latest: -20_000 }),
    balance({ coaId: "retained", accountName: "Retained Earnings", statementSection: "equity", latest: -125_000 }),
  ];
  const BS_COA: CoaAccountRef[] = [
    { id: "accum", parentId: null, accountName: "Accumulated Depreciation", accountNumber: "1590", statementSection: "fixed_assets" },
    { id: "retained", parentId: null, accountName: "Retained Earnings", accountNumber: "3300", statementSection: "equity" },
  ];
  const forecastBs = (coa = BS_COA) => {
    const pl = run({ extraDaysToCollect: 15 }).result;
    const cashFlow = run({ extraDaysToCollect: 15 }, "cash_flow").result;
    return { pl, cashFlow, bs: buildBalanceSheetForecast({ rows: BS_ROWS, months: MONTHS, coaAccounts: coa, pl, cashFlow })! };
  };
  const keys = [REST, "2026-12", "2027-01", "2027-02"];

  it("still balances in every projected month", () => {
    const { bs } = forecastBs();
    for (const k of keys) expect(bs.rows.reduce((sum, r) => sum + r.amountCentsByMonth[k], 0)).toBe(0);
    // And no balance that has happened is touched.
    BS_ROWS.forEach((original, i) => {
      for (const m of MONTHS) expect(bs.rows[i].amountCentsByMonth[m]).toBe(original.amountCentsByMonth[m]);
    });
  });

  it("moves cash, depreciation and earnings by the other two forecasts, and holds the rest", () => {
    const { bs, pl, cashFlow } = forecastBs();
    const at = (coaId: string, k: string) => bs.rows.find((r) => r.coaId === coaId)!.amountCentsByMonth[k];
    const cumulative = (by: Record<string, number>, upTo: string) => keys.slice(0, keys.indexOf(upTo) + 1).reduce((sum, k) => sum + by[k], 0);

    expect(at("checking", "2027-02")).toBe(90_000 + cumulative(cashFlow.netCentsByMonth, "2027-02")); // the largest bank account
    expect(at("savings", "2027-02")).toBe(10_000);
    expect(at("accum", REST)).toBe(-5_000 - 350);
    expect(at("accum", "2027-02")).toBe(-5_000 - 350 * 4);
    expect(at("retained", "2026-12")).toBe(-125_000 - cumulative(pl.netCentsByMonth, "2026-12"));
    expect(at("payables", "2027-02")).toBe(-20_000);
    expect(at("equipment", "2027-02")).toBe(50_000);

    // Profit and cash differ (depreciation, slower collection): one line carries the gap.
    const timing = bs.rows.find((r) => r.accountName === "Forecast: timing differences")!;
    expect(timing.statementSection).toBe("other_current_assets");
    expect(timing.amountCentsByMonth["2027-02"]).not.toBe(0);
    expect(timing.amountCentsByMonth["2026-10"]).toBe(0);
  });

  it("adds a line of its own where an account carries no balance to move", () => {
    const { bs } = forecastBs([]);
    expect(bs.rows.map((r) => r.accountName)).toEqual(expect.arrayContaining(["Forecast: depreciation", "Forecast: earnings", "Forecast: timing differences"]));
    for (const k of keys) expect(bs.rows.reduce((sum, r) => sum + r.amountCentsByMonth[k], 0)).toBe(0);
  });
});

describe("bills spread over the months they cover", () => {
  // A 2026 property-tax bill of 12,000 dated in the open month (November):
  // eleven months catch up in November, December is still to come.
  const TAX: ForecastSpreadBill = {
    coaId: "rent",
    amountCents: -12_000,
    monthlyCents: -1_000,
    periodMonths: 12,
    periodStartMonth: "2026-01",
    periodEndMonth: "2026-12",
    recognitionCentsByMonth: { "2026-11": -11_000, "2026-12": -1_000 },
    paidMonth: "2026-11",
  };
  const spreadRow = (amounts: number[]) =>
    row({ coaId: "rent", accountName: "Rent", amounts, sourceRef: { table: SERVICE_PERIOD_TABLE } });
  const forecast = (rows: FinancialsRow[], statement: "pl" | "cash_flow", bills: ForecastSpreadBill[], horizonMonths: 3 | 12 = 3) => {
    const result = buildForecast({
      rows,
      months: MONTHS,
      coaAccounts: COA,
      statement,
      drivers: { ...DRIVERS, spreadBills: bills },
      assumptions: { ...BASE_ASSUMPTIONS, horizonMonths },
    });
    if (!result) throw new Error("expected a forecast");
    return result;
  };

  it("forecasts one month's share, not the catch-up month smeared forward", () => {
    const rows = [...ROWS, spreadRow([0, 0, 0, 0, -11_000])];
    const result = forecast(rows, "pl", [TAX]);
    const spread = result.rows[rows.length - 1];
    expect(spread.amountCentsByMonth["2026-12"]).toBe(-1_000); // still on the bill's own schedule
    expect(spread.amountCentsByMonth["2027-01"]).toBe(-1_000); // assumed to renew at the same price
    expect(spread.amountCentsByMonth["2027-02"]).toBe(-1_000);
    expect(spread.amountCentsByMonth[REST]).toBe(0); // November's share is already booked in full
    // The account's ordinary rent and its spread bill share one line on the
    // statement, so the line owns up to being forecast two ways.
    expect(result.methodByKey[methodKey(spread, "unknown")]).toMatch(/Several methods/);
    const alone = forecast([...ROWS.filter((r) => r.coaId !== "rent"), spreadRow([0, 0, 0, 0, -11_000])], "pl", [TAX]);
    expect(alone.methodByKey[methodKey(spread, "unknown")]).toMatch(/one month's share/);
  });

  it("leaves the account's ordinary line forecasting from its own history", () => {
    const rows = [...ROWS, spreadRow([0, 0, 0, 0, -11_000])];
    const result = forecast(rows, "pl", [TAX]);
    const ordinaryRent = result.rows[ROWS.findIndex((r) => r.coaId === "rent")];
    expect(ordinaryRent.amountCentsByMonth["2027-02"]).toBe(-4_100);
  });

  it("stops assuming a renewal once a later bill has replaced it", () => {
    const renewal: ForecastSpreadBill = {
      ...TAX,
      amountCents: -18_000,
      monthlyCents: -1_500,
      periodStartMonth: "2027-01",
      periodEndMonth: "2027-12",
      recognitionCentsByMonth: { "2027-01": -1_500, "2027-02": -1_500 },
      paidMonth: null,
    };
    const rows = [...ROWS, spreadRow([0, 0, 0, 0, -11_000])];
    const spread = forecast(rows, "pl", [TAX, renewal]).rows[rows.length - 1];
    expect(spread.amountCentsByMonth["2026-12"]).toBe(-1_000);
    expect(spread.amountCentsByMonth["2027-01"]).toBe(-1_500); // the new bill alone, not both
  });

  it("puts the whole bill back on the cash-flow forecast a period after it was paid, and nowhere else", () => {
    const rows = [...ROWS, spreadRow([0, 0, 0, 0, -12_000])];
    const result = forecast(rows, "cash_flow", [TAX], 12);
    const spread = result.rows[rows.length - 1];
    for (const m of result.forecastMonths) {
      expect(spread.amountCentsByMonth[m]).toBe(m === "2027-11" ? -12_000 : 0);
    }
    expect(spread.amountCentsByMonth[REST]).toBe(0);
  });

  it("forecasts nothing for a spread row when the drivers predate the field", () => {
    const rows = [...ROWS, spreadRow([0, 0, 0, 0, -11_000])];
    const legacy = { ...DRIVERS } as Partial<ForecastDrivers>;
    delete legacy.spreadBills;
    const result = buildForecast({ rows, months: MONTHS, coaAccounts: COA, statement: "pl", drivers: legacy as ForecastDrivers, assumptions: BASE_ASSUMPTIONS });
    expect(result!.rows[rows.length - 1].amountCentsByMonth["2027-01"]).toBe(0);
  });
});
