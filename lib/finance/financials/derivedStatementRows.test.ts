import { describe, it, expect } from "vitest";
import { injectDepreciationRows, injectInventoryReliefRows, cumulativeDepreciationThrough } from "./derivedStatementRows";
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

describe("injectInventoryReliefRows", () => {
  const source = { accountCoaId: "coa-1210", offsetCoaId: "coa-5100", pool: "rawMaterials" as const };

  it("synthesizes the month's inventory change onto the COGS offset account", () => {
    const rows = injectInventoryReliefRows([], [{ source, valueByMonth: { "2026-05": 2_500_000, "2026-06": 2_400_000 } }], MONTHS, COA);
    expect(rows).toHaveLength(1);
    expect(rows[0].coaId).toBe("coa-5100");
    expect(rows[0].accountName).toBe("Raw Materials Purchases (Inventory change)");
    // Inventory up: a credit against cost. Down: consumed into cost.
    expect(rows[0].amountCentsByMonth).toEqual({ "2026-04": 0, "2026-05": 2_500_000, "2026-06": -100_000 });
  });

  it("merges accounts sharing one offset and injects nothing when values never move", () => {
    const rows = injectInventoryReliefRows(
      [],
      [
        { source, valueByMonth: { "2026-05": 100 } },
        { source: { ...source, accountCoaId: "coa-1220" }, valueByMonth: { "2026-05": 200 } },
        { source: { ...source, accountCoaId: "coa-1230" }, valueByMonth: {} },
      ],
      MONTHS,
      COA,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].amountCentsByMonth["2026-05"]).toBe(300);
    expect((rows[0].sourceRef.ids ?? []).slice().sort()).toEqual(["coa-1210", "coa-1220"]);
  });
});
