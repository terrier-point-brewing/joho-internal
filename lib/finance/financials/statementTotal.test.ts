import { describe, it, expect } from "vitest";
import { statementTotal, totalModeFor, totalColumnLabel } from "./statementTotal";

const MONTHS = ["2026-01", "2026-02", "2026-03"];

describe("totalModeFor", () => {
  it("sums flow statements", () => {
    expect(totalModeFor("pl")).toBe("sum");
    expect(totalModeFor("cash_flow")).toBe("sum");
  });

  it("closes the balance sheet", () => {
    expect(totalModeFor("balance_sheet")).toBe("closing");
  });
});

describe("statementTotal — sum mode", () => {
  it("adds every month", () => {
    expect(statementTotal({ "2026-01": 100, "2026-02": 200, "2026-03": 300 }, MONTHS, "sum")).toBe(600);
  });

  it("treats a missing month as 0 rather than NaN", () => {
    expect(statementTotal({ "2026-01": 100, "2026-03": 300 }, MONTHS, "sum")).toBe(400);
  });
});

describe("statementTotal — closing mode", () => {
  // The regression this whole module exists for: with one synthetic month,
  // summing and closing agreed, so the bug was invisible. With twelve columns
  // the sum is a meaningless multiple of the real balance.
  it("returns the LAST month, not the sum", () => {
    expect(statementTotal({ "2026-01": 100, "2026-02": 200, "2026-03": 300 }, MONTHS, "closing")).toBe(300);
  });

  it("returns a flat balance once, not once per month", () => {
    const flat = { "2026-01": 5000, "2026-02": 5000, "2026-03": 5000 };
    expect(statementTotal(flat, MONTHS, "closing")).toBe(5000);
    expect(statementTotal(flat, MONTHS, "sum")).toBe(15000); // what it used to show
  });

  it("returns 0 when the closing month has no entry", () => {
    expect(statementTotal({ "2026-01": 100 }, MONTHS, "closing")).toBe(0);
  });

  it("keeps a negative closing balance negative (liabilities are stored negative)", () => {
    expect(statementTotal({ "2026-01": -100, "2026-03": -24000 }, MONTHS, "closing")).toBe(-24000);
  });

  it("agrees with sum for a single month — why the bug hid for so long", () => {
    const one = ["2026-07"];
    const row = { "2026-07": 103964 };
    expect(statementTotal(row, one, "closing")).toBe(statementTotal(row, one, "sum"));
  });
});

describe("statementTotal — empty months", () => {
  it("yields 0 in both modes", () => {
    expect(statementTotal({ "2026-01": 100 }, [], "sum")).toBe(0);
    expect(statementTotal({ "2026-01": 100 }, [], "closing")).toBe(0);
  });
});

describe("totalColumnLabel", () => {
  it("labels a balance sheet column 'Balance'", () => {
    expect(totalColumnLabel("closing")).toBe("Balance");
    expect(totalColumnLabel("sum")).toBe("Total");
  });
});
