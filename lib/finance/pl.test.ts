import { describe, it, expect } from "vitest";
import {
  computePlSummary,
  proratedManualRevenue,
  type PlSummaryInputs,
  type ManualNetSalesEntry,
} from "./pl";

const baseInputs = (over: Partial<PlSummaryInputs>): PlSummaryInputs => ({
  taproomNetSalesCents: 0,
  invoiceTotalCents: 0,
  manualRevenueDollars: 0,
  ingredientCostDollars: 0,
  packagingCostDollars: 0,
  operatingExpensesDollars: 0,
  ...over,
});

describe("computePlSummary", () => {
  it("combines cents-derived revenue with dollar COGS and expenses", () => {
    const s = computePlSummary(
      baseInputs({
        taproomNetSalesCents: 100_000, // $1000.00
        invoiceTotalCents: 50_000,     // $500.00
        manualRevenueDollars: 250,     // $250.00 (already dollars)
        ingredientCostDollars: 300,
        packagingCostDollars: 200,
        operatingExpensesDollars: 400,
      })
    );

    expect(s.revenue).toEqual({ taproom: 1000, invoices: 500, manual: 250, total: 1750 });
    expect(s.cogs).toEqual({ ingredients: 300, packaging: 200, total: 500 });
    expect(s.grossProfit).toBe(1250);        // 1750 - 500
    expect(s.operatingExpenses).toBe(400);
    expect(s.operatingIncome).toBe(850);     // 1250 - 400
  });

  it("converts cents revenue to dollars — FAILS if the ÷100 seam is dropped", () => {
    const s = computePlSummary(baseInputs({ invoiceTotalCents: 50_000 }));
    // 50_000 cents is $500.00, not $50,000. A missing ÷100 here would read 50000.
    expect(s.revenue.invoices).toBe(500);
    expect(s.revenue.total).toBe(500);
  });

  it("does NOT divide dollar-denominated cost — FAILS if a stray ÷100 is added", () => {
    const s = computePlSummary(baseInputs({ ingredientCostDollars: 300, packagingCostDollars: 45.5 }));
    expect(s.cogs.ingredients).toBe(300);
    expect(s.cogs.packaging).toBe(45.5);
    expect(s.cogs.total).toBe(345.5);
  });

  it("rounds fractional-cent revenue to whole cents", () => {
    const s = computePlSummary(baseInputs({ taproomNetSalesCents: 12_345 }));
    expect(s.revenue.taproom).toBe(123.45);
  });

  it("handles all-zero / empty inputs", () => {
    const s = computePlSummary(baseInputs({}));
    expect(s.revenue.total).toBe(0);
    expect(s.cogs.total).toBe(0);
    expect(s.grossProfit).toBe(0);
    expect(s.operatingIncome).toBe(0);
  });

  it("produces a negative operating income when costs exceed revenue", () => {
    const s = computePlSummary(
      baseInputs({ taproomNetSalesCents: 10_000, ingredientCostDollars: 250, operatingExpensesDollars: 100 })
    );
    // $100 revenue - $250 COGS - $100 expenses = -$250
    expect(s.grossProfit).toBe(-150);
    expect(s.operatingIncome).toBe(-250);
  });
});

describe("proratedManualRevenue", () => {
  const entry = (over: Partial<ManualNetSalesEntry>): ManualNetSalesEntry => ({
    start_date: "2026-01-01",
    end_date: "2026-01-31",
    amount_cents: 0,
    ...over,
  });

  it("returns 0 for no entries", () => {
    expect(proratedManualRevenue([], "2026-01-01", "2026-12-31")).toBe(0);
  });

  it("returns the full amount in dollars when the window covers the whole entry", () => {
    const r = proratedManualRevenue(
      [entry({ start_date: "2026-01-01", end_date: "2026-01-31", amount_cents: 310_000 })],
      "2026-01-01",
      "2026-01-31"
    );
    expect(r).toBe(3100); // 310_000 cents → $3,100.00, all 31 days in window
  });

  it("prorates by overlapping days and converts cents → dollars", () => {
    // 10-day entry worth $1000; window overlaps 5 of those days → $500.
    const r = proratedManualRevenue(
      [entry({ start_date: "2026-06-01", end_date: "2026-06-10", amount_cents: 100_000 })],
      "2026-06-06",
      "2026-06-15"
    );
    expect(r).toBe(500);
  });

  it("excludes entries with no overlap", () => {
    const r = proratedManualRevenue(
      [entry({ start_date: "2026-01-01", end_date: "2026-01-31", amount_cents: 500_000 })],
      "2026-03-01",
      "2026-03-31"
    );
    expect(r).toBe(0);
  });

  it("treats amount_cents as cents — FAILS if the ÷100 seam is dropped", () => {
    // A single-day entry fully inside a single-day window: no proration, pure conversion.
    const r = proratedManualRevenue(
      [entry({ start_date: "2026-03-15", end_date: "2026-03-15", amount_cents: 100 })],
      "2026-03-15",
      "2026-03-15"
    );
    expect(r).toBe(1); // 100 cents = $1.00
  });

  it("sums multiple entries", () => {
    const r = proratedManualRevenue(
      [
        entry({ start_date: "2026-01-01", end_date: "2026-01-01", amount_cents: 10_000 }),
        entry({ start_date: "2026-01-02", end_date: "2026-01-02", amount_cents: 20_000 }),
      ],
      "2026-01-01",
      "2026-01-31"
    );
    expect(r).toBe(300); // $100 + $200
  });
});
