import { describe, it, expect } from "vitest";
import { buildSpendWatch, defaultFocusMonth, baselineMonthsFor } from "./spendWatch";
import type { FinancialsRow, CoaAccountRef } from "./types";

const MONTHS = ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];

function row(overrides: Partial<FinancialsRow> = {}): FinancialsRow {
  return {
    coaId: "rent",
    parentId: null,
    accountName: "OPERATING EXPENSES:Facilities & Occupancy:Building & Land Rent",
    statementSection: "expenses",
    channel: "unknown",
    posCategory: null,
    kegSize: null,
    amountCentsByMonth: {},
    bblByMonth: {},
    bblCoverage: "full",
    mappingSource: "rule",
    sourceRef: { table: "expenses" },
    ...overrides,
  };
}

describe("defaultFocusMonth", () => {
  it("steps back one month when the last month is the open month", () => {
    expect(defaultFocusMonth(MONTHS, "2026-10")).toBe("2026-09");
  });
  it("uses the last month when it has ended", () => {
    expect(defaultFocusMonth(MONTHS, "2026-11")).toBe("2026-10");
  });
  it("uses the only month there is, even if open", () => {
    expect(defaultFocusMonth(["2026-10"], "2026-10")).toBe("2026-10");
    expect(defaultFocusMonth([], "2026-10")).toBeNull();
  });
});

describe("baselineMonthsFor", () => {
  it("takes up to N months before focus, ascending", () => {
    expect(baselineMonthsFor(MONTHS, "2026-10", 3)).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(baselineMonthsFor(MONTHS, "2026-07", 3)).toEqual(["2026-06"]);
    expect(baselineMonthsFor(MONTHS, "2026-06", 3)).toEqual([]);
  });
});

describe("buildSpendWatch", () => {
  it("reports spend as positive magnitudes against a trailing average", () => {
    const rows = [
      row({ amountCentsByMonth: { "2026-07": -669000, "2026-08": -669000, "2026-09": -669000, "2026-10": -1338000 } }),
    ];
    const r = buildSpendWatch(rows, MONTHS, "2026-10");
    expect(r.baselineMonths).toEqual(["2026-07", "2026-08", "2026-09"]);
    const m = r.movers[0];
    expect(m.focusCents).toBe(1338000);
    expect(m.baselineCents).toBe(669000);
    expect(m.deltaCents).toBe(669000);
    expect(m.deltaPct).toBe(100);
    expect(m.kind).toBe("up");
    expect(m.flagged).toBe(true);
    expect(m.shortName).toBe("Building & Land Rent");
    expect(m.groupName).toBe("Facilities & Occupancy");
  });

  it("does not flag a big percent move on a tiny account, nor a tiny percent move on a big one", () => {
    const rows = [
      row({ coaId: "small", accountName: "Bank Fees", amountCentsByMonth: { "2026-09": 5000, "2026-10": -12000 } }),
      row({ coaId: "big", accountName: "Payroll", amountCentsByMonth: { "2026-09": -2000000, "2026-10": -2100000 } }),
    ].map((r) => ({ ...r, amountCentsByMonth: Object.fromEntries(Object.entries(r.amountCentsByMonth).map(([k, v]) => [k, k === "2026-09" && r.coaId === "small" ? -5000 : v])) }));
    const r = buildSpendWatch(rows, MONTHS, "2026-10", { baselineMonths: 1 });
    const small = r.movers.find((m) => m.coaId === "small")!;
    const big = r.movers.find((m) => m.coaId === "big")!;
    expect(small.deltaPct).toBe(140);
    expect(small.flagged).toBe(false); // $70, under $250
    expect(big.deltaCents).toBe(100000);
    expect(big.flagged).toBe(false); // $1,000 but only 5%
  });

  it("marks new and stopped spend, and sums channel slices onto one account", () => {
    const rows = [
      row({ coaId: "sub", accountName: "Software", channel: "taproom", amountCentsByMonth: { "2026-10": -30000 } }),
      row({ coaId: "sub", accountName: "Software", channel: "events", amountCentsByMonth: { "2026-10": -10000 } }),
      row({ coaId: "old", accountName: "Consulting", amountCentsByMonth: { "2026-08": -90000, "2026-09": -90000 } }),
    ];
    const r = buildSpendWatch(rows, MONTHS, "2026-10");
    const sub = r.movers.find((m) => m.coaId === "sub")!;
    expect(sub.focusCents).toBe(40000);
    expect(sub.kind).toBe("new");
    expect(sub.deltaPct).toBeNull();
    expect(sub.flagged).toBe(true);
    expect(r.newSpend.map((m) => m.coaId)).toEqual(["sub"]);
    const old = r.movers.find((m) => m.coaId === "old")!;
    expect(old.kind).toBe("stopped");
    expect(old.baselineCents).toBe(60000); // (0 + 90000 + 90000) / 3
    expect(old.deltaCents).toBe(-60000);
  });

  it("ignores revenue and unmapped rows and prefers the chart's name and number", () => {
    const coa: CoaAccountRef[] = [
      { id: "rent", parentId: null, accountName: "Facilities:Rent", accountNumber: "6210", statementSection: "expenses" },
    ];
    const rows = [
      row({ accountName: "Facilities:Rent (Manual Adjustment)", amountCentsByMonth: { "2026-10": -100000 } }),
      row({ coaId: "rev", statementSection: "revenue", amountCentsByMonth: { "2026-10": 500000 } }),
      row({ coaId: null, amountCentsByMonth: { "2026-10": -500000 } }),
    ];
    const r = buildSpendWatch(rows, MONTHS, "2026-10", { coaAccounts: coa });
    expect(r.movers).toHaveLength(1);
    expect(r.movers[0].accountNumber).toBe("6210");
    expect(r.movers[0].shortName).toBe("Rent");
    expect(r.totalFocusCents).toBe(100000);
  });

  it("orders flagged movers first, then by absolute delta", () => {
    const rows = [
      row({ coaId: "a", amountCentsByMonth: { "2026-09": -100000, "2026-10": -140000 } }), // +$400, 40% → flagged
      row({ coaId: "b", amountCentsByMonth: { "2026-09": -100000, "2026-10": -110000 } }), // +$100 → not
      row({ coaId: "c", amountCentsByMonth: { "2026-09": -500000, "2026-10": -400000 } }), // -$1000, 20% → flagged
    ];
    const r = buildSpendWatch(rows, MONTHS, "2026-10", { baselineMonths: 1 });
    expect(r.movers.map((m) => m.coaId)).toEqual(["c", "a", "b"]);
  });
});
