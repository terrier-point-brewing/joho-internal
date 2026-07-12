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
  strandedDeposit: "/finance/transactions?filter=strandedDeposit",
  exciseCoverage: "/finance/transactions?filter=exciseCoverage",
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
      strandedDeposit: { count: 0, cents: 0 },
      exciseCoverage: { shipmentsMissingExcise: 0 },
    });

    expect(dq.unmapped).toEqual({ count: 1, cents: 7000, href: HREFS.unmapped });
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
      strandedDeposit: { count: 0, cents: 0 },
      exciseCoverage: { shipmentsMissingExcise: 0 },
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
      strandedDeposit: { count: 0, cents: 0 },
      exciseCoverage: { shipmentsMissingExcise: 0 },
    });

    expect(dq.unknownVolume).toEqual({ count: 2, cents: 4000, href: HREFS.unknownVolume });
  });

  // M2 fix: by-the-glass DRAFT POS rows are ALWAYS bblCoverage "unknown" (no
  // per-line keg/can BBL for draft pours -- see volume.ts's rowBbl), so they
  // must not flood this bucket with ordinary, non-actionable draft revenue.
  // Non-draft beer rows (e.g. kegs) with incomplete coverage still count.
  it("excludes DRAFT rows from unknownVolume even when bblCoverage isn't full", () => {
    const rows: FinancialsRow[] = [
      row({ posCategory: "DRAFT_BEER", bblCoverage: "unknown", amountCentsByMonth: { "2026-01": 5000, "2026-02": 0 } }),
      row({ posCategory: "KEGS", bblCoverage: "unknown", amountCentsByMonth: { "2026-01": 3000, "2026-02": 0 } }),
    ];

    const dq = buildDataQuality(rows, {
      hrefs: HREFS,
      strandedDeposit: { count: 0, cents: 0 },
      exciseCoverage: { shipmentsMissingExcise: 0 },
    });

    // Only the non-draft (KEGS) row counts.
    expect(dq.unknownVolume).toEqual({ count: 1, cents: 3000, href: HREFS.unknownVolume });
  });

  it("passes strandedDeposit and exciseCoverage through unchanged, attaching hrefs", () => {
    const dq = buildDataQuality([], {
      hrefs: HREFS,
      strandedDeposit: { count: 3, cents: 42000 },
      exciseCoverage: { shipmentsMissingExcise: 7 },
    });

    expect(dq.strandedDeposit).toEqual({ count: 3, cents: 42000, href: HREFS.strandedDeposit });
    expect(dq.exciseCoverage).toEqual({ shipmentsMissingExcise: 7, href: HREFS.exciseCoverage });
  });
});

describe("isUnknownVolume (M2 fix)", () => {
  it("returns false for a DRAFT row with bblCoverage 'unknown'", () => {
    const r = row({ posCategory: "DRAFT_BEER", bblCoverage: "unknown" });
    expect(isUnknownVolume(r)).toBe(false);
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
