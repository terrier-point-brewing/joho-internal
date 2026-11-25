import { describe, expect, it } from "vitest";
import type { CoaAccountRef, FinancialsRow } from "@/lib/finance/financials/types";
import { buildForecast, methodKey, trailingMonthsOf } from "./forecast";
import { BASE_ASSUMPTIONS, type ForecastAssumptions, type ForecastDrivers } from "./types";

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
    for (const r of result.rows) expect(Object.keys(r.amountCentsByMonth)).toEqual([...MONTHS, ...result.forecastMonths]);
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
    // 5 days of November left after the 25th, at December's daily rate.
    expect(cash["2026-12"]).toBe(Math.round(100_000 + (net["2026-12"] * 5) / 30 + net["2026-12"]));
    expect(cash["2027-01"]).toBeCloseTo(cash["2026-12"] + net["2027-01"], 0);

    const late = run({ extraDaysToCollect: 15 }, "cash_flow");
    // Half of December's invoiced cash is replaced by half of the recent average.
    expect(late.at("contract", "2026-12")).toBe(Math.round(0.5 * cf.at("contract", "2026-12") + 0.5 * 10_000));
    expect(late.at("taproom", "2026-12")).toBe(cf.at("taproom", "2026-12"));
    expect(run({ extraDaysToCollect: 15 }).at("contract", "2026-12")).toBe(run().at("contract", "2026-12"));
  });
});
