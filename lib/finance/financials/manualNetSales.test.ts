import { describe, it, expect } from "vitest";
import { proratedManualAdjustment, injectManualNetSales } from "./manualNetSales";
import type { FinancialsRow } from "./types";

describe("proratedManualAdjustment", () => {
  it("attributes the full amount when an entry spans the whole month", () => {
    const entries = [{ id: "m-1", startDate: "2026-05-01", endDate: "2026-05-31", amountCents: 891300 }];
    const { cents, ids } = proratedManualAdjustment(entries, "2026-05");
    expect(cents).toBe(891300);
    expect(ids).toEqual(["m-1"]);
  });

  it("day-weights an entry whose window only partially overlaps the target month", () => {
    // Entry spans Apr 16 - May 15 (30 inclusive days total). Overlap with May
    // (2026-05) is May 1-15 (15 inclusive days). 100000 * 15 / 30 = 50000.
    const entries = [{ id: "m-3", startDate: "2026-04-16", endDate: "2026-05-15", amountCents: 100000 }];
    const { cents, ids } = proratedManualAdjustment(entries, "2026-05");
    expect(cents).toBe(50000);
    expect(ids).toEqual(["m-3"]);
  });

  it("returns 0 cents and no ids when the entry does not overlap the month", () => {
    const entries = [{ id: "m-4", startDate: "2026-01-01", endDate: "2026-01-31", amountCents: 500000 }];
    const { cents, ids } = proratedManualAdjustment(entries, "2026-05");
    expect(cents).toBe(0);
    expect(ids).toEqual([]);
  });

  it("sums contributions from multiple overlapping entries", () => {
    const entries = [
      { id: "m-5", startDate: "2026-05-01", endDate: "2026-05-31", amountCents: 100000 },
      { id: "m-6", startDate: "2026-04-16", endDate: "2026-05-15", amountCents: 100000 },
    ];
    const { cents, ids } = proratedManualAdjustment(entries, "2026-05");
    expect(cents).toBe(150000);
    expect(ids.sort()).toEqual(["m-5", "m-6"]);
  });
});

describe("injectManualNetSales", () => {
  const months = ["2026-04", "2026-05", "2026-06"];

  it("synthesizes a taproom revenue row with the exact day-weighted values per month", () => {
    const entries = [{ id: "m-1", startDate: "2026-04-16", endDate: "2026-05-15", amountCents: 100000 }];
    const rows = injectManualNetSales([], entries, months);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.channel).toBe("taproom");
    expect(row.statementSection).toBe("revenue");
    expect(row.accountName).toBe("Manual Net-Sales Adjustment");
    expect(row.coaId).toBeNull();
    expect(row.mappingSource).toBe("manual");
    expect(row.bblCoverage).toBe("full");
    expect(row.bblByMonth).toEqual({});
    expect(row.sourceRef).toEqual({ table: "manual_net_sales_entries", ids: ["m-1"] });

    // Apr 16-30 (15 inclusive days) overlap of a 30-day entry -> 50000.
    expect(row.amountCentsByMonth["2026-04"]).toBe(50000);
    // May 1-15 (15 inclusive days) overlap -> 50000.
    expect(row.amountCentsByMonth["2026-05"]).toBe(50000);
    // No overlap with June.
    expect(row.amountCentsByMonth["2026-06"]).toBe(0);
  });

  it("appends to existing rows rather than replacing them", () => {
    const existing: FinancialsRow = {
      coaId: "coa-rev", parentId: null, accountName: "Taproom Sales", statementSection: "revenue",
      channel: "taproom", posCategory: null, kegSize: null,
      amountCentsByMonth: { "2026-05": 5000 }, bblByMonth: {}, bblCoverage: "full",
      mappingSource: "manual", sourceRef: { table: "pos_line_items", ids: ["pos-1"] },
    };
    const entries = [{ id: "m-1", startDate: "2026-05-01", endDate: "2026-05-31", amountCents: 891300 }];
    const rows = injectManualNetSales([existing], entries, months);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe(existing);
    expect(rows[1].sourceRef.table).toBe("manual_net_sales_entries");
  });

  it("returns rows unchanged when no entry overlaps any month in the window", () => {
    const entries = [{ id: "m-1", startDate: "2025-01-01", endDate: "2025-01-31", amountCents: 100000 }];
    const rows = injectManualNetSales([], entries, months);
    expect(rows).toEqual([]);
  });

  it("returns rows unchanged when there are no entries at all", () => {
    const rows = injectManualNetSales([], [], months);
    expect(rows).toEqual([]);
  });

  it("deduplicates ids across months and omits ids from non-overlapping entries", () => {
    const entries = [
      { id: "m-full", startDate: "2026-04-01", endDate: "2026-06-30", amountCents: 300000 },
      { id: "m-outside", startDate: "2027-01-01", endDate: "2027-01-31", amountCents: 999 },
    ];
    const rows = injectManualNetSales([], entries, months);
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceRef.ids).toEqual(["m-full"]);
  });
});
