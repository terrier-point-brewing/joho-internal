import { describe, it, expect } from "vitest";
import { buildKpis, buildDataQuality, isUnknownVolume } from "./summaries";
import type { FinancialsRow } from "./types";

const MONTHS = ["2026-01", "2026-02"];

function row(overrides: Partial<FinancialsRow> = {}): FinancialsRow {
  return {
    coaId: "coa-1",
    parentId: null,
    accountName: "Beer Sales",
    statementSection: "revenue",
    channel: "taproom",
    posCategory: null,
    kegSize: null,
    amountCentsByMonth: {},
    bblByMonth: {},
    bblCoverage: "full",
    mappingSource: "manual",
    sourceRef: { table: "pos_line_items", ids: ["1"] },
    ...overrides,
  };
}

const HREFS = {
  unmapped: "/finance/transactions?filter=unmapped",
  uncategorized: "/finance/transactions?filter=uncategorized",
  unknownVolume: "/finance/transactions?filter=unknownVolume",
  exciseCoverage: "/finance/transactions?filter=exciseCoverage",
  unmappedTaxes: "/settings/finance/sales-tax-accounts",
};

describe("buildKpis", () => {
  it("computes revenue MoM% correctly across 2 months", () => {
    const rows: FinancialsRow[] = [
      row({
        statementSection: "revenue",
        amountCentsByMonth: { "2026-01": 100000, "2026-02": 150000 },
      }),
    ];

    const kpis = buildKpis(rows, MONTHS);

    expect(kpis.revenueCents).toEqual({ "2026-01": 100000, "2026-02": 150000 });
    // First month has no prior month to compare against.
    expect(kpis.revenueMoMPct["2026-01"]).toBe(0);
    // (150000 - 100000) / 100000 * 100 = 50
    expect(kpis.revenueMoMPct["2026-02"]).toBe(50);
  });

  it("computes gross margin = (rev - cogs) / rev", () => {
    const rows: FinancialsRow[] = [
      row({
        coaId: "coa-rev",
        statementSection: "revenue",
        amountCentsByMonth: { "2026-01": 100000, "2026-02": 0 },
      }),
      row({
        coaId: "coa-cogs",
        statementSection: "cogs",
        amountCentsByMonth: { "2026-01": -40000, "2026-02": 0 },
      }),
    ];

    const kpis = buildKpis(rows, MONTHS);

    // (100000 - 40000) / 100000 * 100 = 60
    expect(kpis.grossMarginPct["2026-01"]).toBe(60);
    // Zero revenue -> defined as 0, not NaN/Infinity.
    expect(kpis.grossMarginPct["2026-02"]).toBe(0);
  });

  it("computes netIncomeCents as the sum of all P&L-section rows per month", () => {
    const rows: FinancialsRow[] = [
      row({ coaId: "coa-rev", statementSection: "revenue", amountCentsByMonth: { "2026-01": 100000, "2026-02": 0 } }),
      row({ coaId: "coa-cogs", statementSection: "cogs", amountCentsByMonth: { "2026-01": -40000, "2026-02": 0 } }),
      row({ coaId: "coa-exp", statementSection: "expenses", amountCentsByMonth: { "2026-01": -10000, "2026-02": 0 } }),
      // Balance-sheet section rows must NOT bleed into net income.
      row({ coaId: "coa-bank", statementSection: "bank", amountCentsByMonth: { "2026-01": 500000, "2026-02": 0 } }),
    ];

    const kpis = buildKpis(rows, MONTHS);

    expect(kpis.netIncomeCents["2026-01"]).toBe(50000);
    expect(kpis.netIncomeCents["2026-02"]).toBe(0);
  });

  it("defaults cashOnHandCents to null when not provided", () => {
    const kpis = buildKpis([], MONTHS);
    expect(kpis.cashOnHandCents).toBeNull();
  });

  it("passes through cashOnHandCents when provided", () => {
    const kpis = buildKpis([], MONTHS, { cashOnHandCents: 987654 });
    expect(kpis.cashOnHandCents).toBe(987654);
  });

  it("defaults operatingCashCents to null when not provided", () => {
    const kpis = buildKpis([], MONTHS);
    expect(kpis.operatingCashCents).toBeNull();
  });

  it("passes through operatingCashCents unchanged when provided", () => {
    const supplied = { "2026-01": 12345, "2026-02": -6789 };
    const kpis = buildKpis([], MONTHS, { operatingCashCents: supplied });
    expect(kpis.operatingCashCents).toEqual(supplied);
  });
});

describe("buildDataQuality", () => {
  it("buckets unmapped rows (coaId === null) by count + summed abs cents", () => {
    const rows: FinancialsRow[] = [
      row({ coaId: null, amountCentsByMonth: { "2026-01": 5000, "2026-02": -2000 } }),
      row({ coaId: "coa-1", amountCentsByMonth: { "2026-01": 1000, "2026-02": 0 } }),
    ];

    const dq = buildDataQuality(rows, {
      hrefs: HREFS,
        exciseCoverage: { shipmentsMissingExcise: 0 },
      unmappedTaxes: { count: 0, cents: 0 },
    });

    expect(dq.unmapped).toEqual({ count: 1, cents: 7000, href: HREFS.unmapped });
  });

  // manualNetSales.ts's injectManualNetSales now synthesizes its taproom
  // adjustment row with a real coaId (Square parity fix B follow-up), so a
  // manual flow entry's row falls out of the unmapped bucket on its own
  // merits -- no special-case keyed on sourceRef.table is needed anymore.
  it("does not count a manual flow-entry row with a real coaId as unmapped", () => {
    const rows: FinancialsRow[] = [
      row({
        coaId: "coa-rev",
        accountName: "Manual Net-Sales Adjustment",
        sourceRef: { table: "manual_entries", ids: ["m-1"] },
        amountCentsByMonth: { "2026-01": 5000, "2026-02": 0 },
      }),
    ];

    const dq = buildDataQuality(rows, {
      hrefs: HREFS,
      exciseCoverage: { shipmentsMissingExcise: 0 },
      unmappedTaxes: { count: 0, cents: 0 },
    });

    expect(dq.unmapped).toEqual({ count: 0, cents: 0, href: HREFS.unmapped });
  });

  it("buckets uncategorized rows (channel === 'unknown' on a revenue/other_income row) by count + summed abs cents", () => {
    const rows: FinancialsRow[] = [
      row({ statementSection: "revenue", channel: "unknown", amountCentsByMonth: { "2026-01": 3000, "2026-02": 0 } }),
      row({ statementSection: "revenue", channel: "taproom", amountCentsByMonth: { "2026-01": 1000, "2026-02": 0 } }),
      // Expense/bank/refund rows are hardcoded to channel: "unknown" by
      // aggregateRows.ts (no sales-channel dimension) -- they must NOT be
      // flagged uncategorized just for lacking a channel.
      row({ statementSection: "expenses", channel: "unknown", amountCentsByMonth: { "2026-01": 9000, "2026-02": 0 } }),
    ];

    const dq = buildDataQuality(rows, {
      hrefs: HREFS,
        exciseCoverage: { shipmentsMissingExcise: 0 },
      unmappedTaxes: { count: 0, cents: 0 },
    });

    expect(dq.uncategorized).toEqual({ count: 1, cents: 3000, href: HREFS.uncategorized });
  });

  it("buckets unknownVolume rows (bblCoverage !== 'full') by count + summed abs cents", () => {
    const rows: FinancialsRow[] = [
      row({ bblCoverage: "unknown", amountCentsByMonth: { "2026-01": 2500, "2026-02": 0 } }),
      row({ bblCoverage: "partial", amountCentsByMonth: { "2026-01": 1500, "2026-02": 0 } }),
      row({ bblCoverage: "full", amountCentsByMonth: { "2026-01": 1000, "2026-02": 0 } }),
    ];

    const dq = buildDataQuality(rows, {
      hrefs: HREFS,
        exciseCoverage: { shipmentsMissingExcise: 0 },
      unmappedTaxes: { count: 0, cents: 0 },
    });

    expect(dq.unknownVolume).toEqual({ count: 2, cents: 4000, href: HREFS.unknownVolume });
  });

  // Post-fix, an ordinary draft row resolves bblCoverage "full" (rowBbl now
  // derives BBL from the variation's fl-oz), so it never reaches this
  // bucket. A DRAFT row that IS bblCoverage "unknown" means variationName
  // was missing -- a genuine gap -- and should count same as any other
  // under-covered beer row (e.g. kegs).
  it("counts DRAFT rows in unknownVolume when bblCoverage isn't full (genuine gap, not routine draft revenue)", () => {
    const rows: FinancialsRow[] = [
      row({ posCategory: "DRAFT_BEER", bblCoverage: "unknown", amountCentsByMonth: { "2026-01": 5000, "2026-02": 0 } }),
      row({ posCategory: "KEGS", bblCoverage: "unknown", amountCentsByMonth: { "2026-01": 3000, "2026-02": 0 } }),
    ];

    const dq = buildDataQuality(rows, {
      hrefs: HREFS,
        exciseCoverage: { shipmentsMissingExcise: 0 },
      unmappedTaxes: { count: 0, cents: 0 },
    });

    // Both rows count now that DRAFT is no longer special-cased.
    expect(dq.unknownVolume).toEqual({ count: 2, cents: 8000, href: HREFS.unknownVolume });
  });

  it("passes exciseCoverage through unchanged, attaching hrefs", () => {
    const dq = buildDataQuality([], {
      hrefs: HREFS,
      exciseCoverage: { shipmentsMissingExcise: 7 },
      unmappedTaxes: { count: 0, cents: 0 },
    });

    expect(dq.exciseCoverage).toEqual({ shipmentsMissingExcise: 7, href: HREFS.exciseCoverage });
  });

  it("passes unmappedTaxes through from opts with its href", () => {
    const dq = buildDataQuality([], {
      hrefs: {
        unmapped: "/u", uncategorized: "/c", unknownVolume: "/v",
        exciseCoverage: "/e", unmappedTaxes: "/settings/finance/sales-tax-accounts",
      },
      exciseCoverage: { shipmentsMissingExcise: 0 },
      unmappedTaxes: { count: 1, cents: 24204 },
    });
    expect(dq.unmappedTaxes).toEqual({ count: 1, cents: 24204, href: "/settings/finance/sales-tax-accounts" });
  });
});

describe("isUnknownVolume (simplified post Square-parity fix A)", () => {
  it("returns true for a DRAFT row with bblCoverage 'unknown' (genuine gap, no longer special-cased)", () => {
    const r = row({ posCategory: "DRAFT_BEER", bblCoverage: "unknown" });
    expect(isUnknownVolume(r)).toBe(true);
  });

  it("returns true for a non-draft beer row (e.g. keg) with bblCoverage 'unknown'", () => {
    const r = row({ posCategory: "KEGS", bblCoverage: "unknown" });
    expect(isUnknownVolume(r)).toBe(true);
  });

  it("returns false for any row with bblCoverage 'full', draft or not", () => {
    expect(isUnknownVolume(row({ posCategory: "DRAFT_BEER", bblCoverage: "full" }))).toBe(false);
    expect(isUnknownVolume(row({ posCategory: "KEGS", bblCoverage: "full" }))).toBe(false);
  });

  it("returns true for a DRAFT-adjacent-but-not-draft partial-coverage row", () => {
    const r = row({ posCategory: "CANS", bblCoverage: "partial" });
    expect(isUnknownVolume(r)).toBe(true);
  });
});
