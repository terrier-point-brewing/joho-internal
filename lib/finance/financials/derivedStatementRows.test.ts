import { describe, it, expect } from "vitest";
import { injectDepreciationRows, injectExciseExpenseRows, injectInventoryCostRows, injectSquareFeeRows, cumulativeDepreciationThrough } from "./derivedStatementRows";
import { reliefDeltasByMonth } from "@/lib/finance/inventoryRelief";
import type { ScheduleState } from "@/lib/finance/depreciation/state";
import type { CoaRecord } from "./aggregateRows";

const COA: CoaRecord[] = [
  { id: "coa-7020", parentId: "coa-7000", accountName: "Depreciation & Amortization", accountNumber: "7020", accountType: "Other Expense", statementSection: null },
  { id: "coa-5100", parentId: "coa-5000", accountName: "Raw Materials Purchases", accountNumber: "5100", accountType: "Cost of Goods Sold", statementSection: null },
];

const MONTHS = ["2026-04", "2026-05", "2026-06"];

function schedule(over: Partial<ScheduleState> = {}): ScheduleState {
  return {
    id: "sched-1",
    assetChartOfAccountsId: "coa-1520",
    expenseChartOfAccountsId: "coa-7020",
    contraChartOfAccountsId: "coa-1590",
    endedMonth: null,
    revisions: [{ effectiveMonth: null, lifeMonths: 10 }],
    additions: [{ month: "2026-04", cents: 100_000 }], // $100/mo over 10
    ...over,
  };
}

describe("injectDepreciationRows", () => {
  it("synthesizes one negative expense row on the schedule's expense account", () => {
    const rows = injectDepreciationRows([], [schedule()], MONTHS, COA);
    expect(rows).toHaveLength(1);
    expect(rows[0].coaId).toBe("coa-7020");
    expect(rows[0].accountName).toBe("Depreciation & Amortization (Depreciation)");
    // The real account's parent, so buildTree nests it — see injectManualNetSales.
    expect(rows[0].parentId).toBe("coa-7000");
    expect(rows[0].amountCentsByMonth).toEqual({ "2026-04": -10_000, "2026-05": -10_000, "2026-06": -10_000 });
    expect(rows[0].mappingSource).toBe("rule");
    expect(rows[0].sourceRef).toEqual({ table: "depreciation_schedules", ids: ["sched-1"] });
  });

  it("merges schedules sharing an expense account into one row", () => {
    const rows = injectDepreciationRows(
      [],
      [schedule(), schedule({ id: "sched-2", assetChartOfAccountsId: "coa-1550", additions: [{ month: "2026-05", cents: 50_000 }], revisions: [{ effectiveMonth: null, lifeMonths: 5 }] })],
      MONTHS,
      COA,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].amountCentsByMonth["2026-05"]).toBe(-20_000); // 10k + 50k/5
    expect((rows[0].sourceRef.ids ?? []).slice().sort()).toEqual(["sched-1", "sched-2"]);
  });

  it("injects nothing when no schedule charges inside the window", () => {
    const rows = injectDepreciationRows([], [schedule({ additions: [{ month: "2027-01", cents: 100_000 }] })], MONTHS, COA);
    expect(rows).toHaveLength(0);
  });

  it("cumulativeDepreciationThrough matches the injected months to the cent", () => {
    const states = [schedule()];
    const injected = injectDepreciationRows([], states, MONTHS, COA)[0];
    const sum = MONTHS.reduce((total, m) => total + injected.amountCentsByMonth[m], 0);
    expect(cumulativeDepreciationThrough(states, "2026-06")).toBe(sum);
  });
});

describe("reliefDeltasByMonth", () => {
  // The first month a value exists relieves the whole of it — the catch-up
  // for a business that expensed every purchase until tracking began.
  it("relieves the whole first value, then only the changes", () => {
    const deltas = reliefDeltasByMonth({ "2026-05": 2_500_000, "2026-06": 2_600_000 }, MONTHS);
    expect(deltas).toEqual({ "2026-04": 0, "2026-05": 2_500_000, "2026-06": 100_000 });
  });

  it("carries the last known value across a gap month", () => {
    const deltas = reliefDeltasByMonth({ "2026-04": 1_000_000, "2026-06": 900_000 }, MONTHS);
    expect(deltas).toEqual({ "2026-04": 1_000_000, "2026-05": 0, "2026-06": -100_000 });
  });

  it("uses a value from before the window as the base instead of re-relieving it", () => {
    const deltas = reliefDeltasByMonth({ "2026-03": 1_000_000, "2026-04": 1_050_000 }, MONTHS);
    expect(deltas).toEqual({ "2026-04": 50_000, "2026-05": 0, "2026-06": 0 });
  });
});

describe("reliefDeltasByMonth — opening balance", () => {
  it("treats the first value as an opening balance when asked: no change that month, only later moves", () => {
    const deltas = reliefDeltasByMonth({ "2026-05": 2_500_000, "2026-06": 2_600_000 }, MONTHS, { excludeOpening: true });
    expect(deltas).toEqual({ "2026-04": 0, "2026-05": 0, "2026-06": 100_000 });
  });
});

describe("injectInventoryCostRows", () => {
  const raw = { accountCoaId: "coa-1210", offsetCoaId: "coa-5100", pool: "rawMaterials" as const };
  const COA_WITH_6460 = [
    ...COA,
    { id: "coa-6460", parentId: null, accountName: "Inventory Shrinkage & Adjustments", accountNumber: "6460", accountType: "Expenses", statementSection: null },
  ];
  /** A real purchase row on the offset account: $1,000 in May, $500 in June. */
  const purchase = {
    coaId: "coa-5100",
    parentId: null,
    accountName: "Raw Materials Purchases",
    statementSection: "cogs",
    channel: "unknown" as const,
    posCategory: null,
    kegSize: null,
    amountCentsByMonth: { "2026-04": 0, "2026-05": -100_000, "2026-06": -50_000 },
    bblByMonth: {},
    bblCoverage: "full" as const,
    // Rule-mapped on purpose: most real purchases are, and a guard on
    // mappingSource once left them all out of the capitalisation.
    mappingSource: "rule" as const,
    sourceRef: { table: "expenses", ids: ["e1", "e2"] },
  };
  const sold = { "2026-05": { beerCents: 40_000, packagingCents: 0, ids: ["x1"] }, "2026-06": { beerCents: 60_000, packagingCents: 0, ids: ["x2"] } };

  it("replaces the periodic figure with purchases capitalised, cost of beer sold, and the residual", () => {
    // Shelf: opens at $25,000 in May (equity's business), rises to $25,500 in June.
    const rows = injectInventoryCostRows(
      [purchase],
      [{ source: raw, valueByMonth: { "2026-05": 2_500_000, "2026-06": 2_550_000 } }],
      sold,
      MONTHS,
      COA_WITH_6460,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.accountName, r]));

    // May is the opening month: its purchases stay the cost, no rows.
    expect(byName["Raw Materials Purchases (Capitalised to inventory)"].amountCentsByMonth).toEqual({ "2026-04": 0, "2026-05": 0, "2026-06": 50_000 });
    expect(byName["Raw Materials Purchases (Cost of beer sold)"].amountCentsByMonth).toEqual({ "2026-04": 0, "2026-05": 0, "2026-06": -60_000 });
    // June: +500 − 500 + 600 = +600 gained.
    expect(byName["Inventory Shrinkage & Adjustments (Inventory shrinkage & adjustments)"].amountCentsByMonth).toEqual({ "2026-04": 0, "2026-05": 0, "2026-06": 60_000 });

    // The three derived rows sum to the month's change in inventory (the
    // purchase row itself is still on the statement), so the P&L nets to
    // change minus purchases — the periodic figure — and retained earnings'
    // cumulative inventory value still ties.
    const derived = rows.filter((r) => r !== purchase);
    const sum = (m: string) => derived.reduce((t, r) => t + (r.amountCentsByMonth[m] ?? 0), 0);
    expect(sum("2026-05")).toBe(0);
    expect(sum("2026-06")).toBe(50_000);
  });

  it("sends beer to the raw-materials offset and packaging to the packaging offset", () => {
    const pkg = { accountCoaId: "coa-1220", offsetCoaId: "coa-5120", pool: "packagingMaterials" as const };
    const coa = [...COA_WITH_6460, { id: "coa-5120", parentId: null, accountName: "Packaging Purchases", accountNumber: "5120", accountType: "Cost of Goods Sold", statementSection: null }];
    const rows = injectInventoryCostRows(
      [],
      [{ source: raw, valueByMonth: { "2026-05": 1 } }, { source: pkg, valueByMonth: { "2026-05": 1 } }],
      { "2026-06": { beerCents: 300, packagingCents: 70, ids: ["x"] } },
      MONTHS,
      coa,
    );
    const byCoa = Object.fromEntries(rows.filter((r) => r.accountName.endsWith("(Cost of beer sold)")).map((r) => [r.coaId, r.amountCentsByMonth["2026-06"]]));
    expect(byCoa).toEqual({ "coa-5100": -300, "coa-5120": -70 });
  });

  it("leaves months through the opening month untouched — their purchases stay the cost", () => {
    const rows = injectInventoryCostRows([purchase], [{ source: raw, valueByMonth: { "2026-05": 2_500_000 } }], sold, MONTHS, COA_WITH_6460);
    for (const r of rows.filter((x) => x !== purchase)) {
      expect(r.amountCentsByMonth["2026-04"]).toBe(0);
      expect(r.amountCentsByMonth["2026-05"]).toBe(0);
    }
    // Tracking that begins in the last month of the window injects nothing at all.
    const none = injectInventoryCostRows([purchase], [{ source: raw, valueByMonth: { "2026-06": 2_500_000 } }], sold, MONTHS, COA_WITH_6460);
    expect(none).toEqual([purchase]);
  });

  it("injects nothing when no shelf is configured", () => {
    expect(injectInventoryCostRows([purchase], [], sold, MONTHS, COA_WITH_6460)).toEqual([purchase]);
  });
});

describe("injectSquareFeeRows", () => {
  const series = { coaId: "coa-5100", feeCentsByMonth: { "2026-05": 64_092, "2026-06": 71_000 } };

  it("synthesizes one negative cost row on the configured account", () => {
    const rows = injectSquareFeeRows([], series, MONTHS, COA);
    expect(rows).toHaveLength(1);
    expect(rows[0].coaId).toBe("coa-5100");
    expect(rows[0].accountName).toBe("Raw Materials Purchases (Card processing fees)");
    expect(rows[0].amountCentsByMonth).toEqual({ "2026-04": 0, "2026-05": -64_092, "2026-06": -71_000 });
    expect(rows[0].sourceRef.table).toBe("square_payment_fees");
  });

  it("injects nothing while no account is configured, or when no month has fees", () => {
    expect(injectSquareFeeRows([], null, MONTHS, COA)).toHaveLength(0);
    expect(injectSquareFeeRows([], { coaId: "coa-5100", feeCentsByMonth: {} }, MONTHS, COA)).toHaveLength(0);
  });
});

describe("injectExciseExpenseRows", () => {
  const COA_WITH_6451: CoaRecord[] = [
    ...COA,
    { id: "coa-6451", parentId: "coa-6450", accountName: "Barrel Excise Taxes Paid", accountNumber: "6451", accountType: "Expenses", statementSection: null },
  ];

  it("synthesizes one negative cost row on GL 6451", () => {
    const rows = injectExciseExpenseRows([], { "2026-05": 12_345, "2026-06": 6_789 }, MONTHS, COA_WITH_6451);
    expect(rows).toHaveLength(1);
    expect(rows[0].coaId).toBe("coa-6451");
    expect(rows[0].accountName).toBe("Barrel Excise Taxes Paid (Excise accrued)");
    expect(rows[0].parentId).toBe("coa-6450");
    expect(rows[0].amountCentsByMonth).toEqual({ "2026-04": 0, "2026-05": -12_345, "2026-06": -6_789 });
    expect(rows[0].mappingSource).toBe("rule");
    expect(rows[0].sourceRef.table).toBe("export_transaction_taxes");
  });

  it("injects nothing without a 6451 account, without data, or with only zero months", () => {
    expect(injectExciseExpenseRows([], { "2026-05": 100 }, MONTHS, COA)).toHaveLength(0);
    expect(injectExciseExpenseRows([], null, MONTHS, COA_WITH_6451)).toHaveLength(0);
    expect(injectExciseExpenseRows([], {}, MONTHS, COA_WITH_6451)).toHaveLength(0);
    // A month outside the asked window must not leak in.
    expect(injectExciseExpenseRows([], { "2026-03": 5_000 }, MONTHS, COA_WITH_6451)).toHaveLength(0);
  });
});
