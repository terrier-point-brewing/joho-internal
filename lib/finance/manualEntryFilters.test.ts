import { describe, it, expect } from "vitest";
import { parseManualEntryFilter, matchesManualEntryFilter, type ManualEntryFilterRow } from "./manualEntryFilters";

describe("parseManualEntryFilter", () => {
  it("no filters -> type none", () => {
    expect(parseManualEntryFilter(null, null)).toEqual({ type: "none" });
  });

  it("unrecognized kind param -> ignored, type none", () => {
    expect(parseManualEntryFilter("bogus", null)).toEqual({ type: "none" });
  });

  it("kind-only: flow", () => {
    expect(parseManualEntryFilter("flow", null)).toEqual({ type: "kind", kind: "flow" });
  });

  it("kind-only: balance", () => {
    expect(parseManualEntryFilter("balance", null)).toEqual({ type: "kind", kind: "balance" });
  });

  it("unparseable year is silently ignored (deliberate, not a 400)", () => {
    expect(parseManualEntryFilter(null, "not-a-year")).toEqual({ type: "none" });
    expect(parseManualEntryFilter("flow", "not-a-year")).toEqual({ type: "kind", kind: "flow" });
  });

  it("year-only for kind=flow", () => {
    expect(parseManualEntryFilter("flow", "2026")).toEqual({
      type: "kind-year",
      kind: "flow",
      yearStart: "2026-01-01",
      yearEnd: "2026-12-31",
    });
  });

  it("year-only for kind=balance", () => {
    expect(parseManualEntryFilter("balance", "2026")).toEqual({
      type: "kind-year",
      kind: "balance",
      yearStart: "2026-01-01",
      yearEnd: "2026-12-31",
    });
  });

  it("combined case (no kind, year present) -> the .or() branch", () => {
    const result = parseManualEntryFilter(null, "2026");
    expect(result.type).toBe("year");
    if (result.type !== "year") throw new Error("expected year filter");
    expect(result.yearStart).toBe("2026-01-01");
    expect(result.yearEnd).toBe("2026-12-31");
    expect(result.or).toBe(
      "and(entry_kind.eq.flow,start_date.lte.2026-12-31,end_date.gte.2026-01-01)," +
        "and(entry_kind.eq.balance,as_of_date.gte.2026-01-01,as_of_date.lte.2026-12-31)",
    );
  });
});

describe("matchesManualEntryFilter — overlap boundary dates", () => {
  const spanningFlow: ManualEntryFilterRow = {
    entryKind: "flow",
    startDate: "2025-12-31",
    endDate: "2026-01-01",
    asOfDate: null,
  };

  it("a flow spanning Dec 31 -> Jan 1 matches the earlier year's kind-year filter", () => {
    const filter = parseManualEntryFilter("flow", "2025");
    expect(matchesManualEntryFilter(filter, spanningFlow)).toBe(true);
  });

  it("a flow spanning Dec 31 -> Jan 1 matches the later year's kind-year filter", () => {
    const filter = parseManualEntryFilter("flow", "2026");
    expect(matchesManualEntryFilter(filter, spanningFlow)).toBe(true);
  });

  it("a flow spanning Dec 31 -> Jan 1 matches the earlier year's combined (.or) filter", () => {
    const filter = parseManualEntryFilter(null, "2025");
    expect(matchesManualEntryFilter(filter, spanningFlow)).toBe(true);
  });

  it("a flow spanning Dec 31 -> Jan 1 matches the later year's combined (.or) filter", () => {
    const filter = parseManualEntryFilter(null, "2026");
    expect(matchesManualEntryFilter(filter, spanningFlow)).toBe(true);
  });

  it("a flow entirely inside 2024 does not match the 2026 filter", () => {
    const filter = parseManualEntryFilter("flow", "2026");
    const row: ManualEntryFilterRow = {
      entryKind: "flow",
      startDate: "2024-03-01",
      endDate: "2024-06-30",
      asOfDate: null,
    };
    expect(matchesManualEntryFilter(filter, row)).toBe(false);
  });

  it("a balance as-of a month end in 2026 matches the 2026 kind-year filter, not 2025", () => {
    const row: ManualEntryFilterRow = {
      entryKind: "balance",
      startDate: null,
      endDate: null,
      asOfDate: "2026-01-31",
    };
    expect(matchesManualEntryFilter(parseManualEntryFilter("balance", "2026"), row)).toBe(true);
    expect(matchesManualEntryFilter(parseManualEntryFilter("balance", "2025"), row)).toBe(false);
  });

  it("type:none matches everything; type:kind filters by entryKind only", () => {
    const row: ManualEntryFilterRow = {
      entryKind: "balance",
      startDate: null,
      endDate: null,
      asOfDate: "2026-01-31",
    };
    expect(matchesManualEntryFilter({ type: "none" }, row)).toBe(true);
    expect(matchesManualEntryFilter({ type: "kind", kind: "balance" }, row)).toBe(true);
    expect(matchesManualEntryFilter({ type: "kind", kind: "flow" }, row)).toBe(false);
  });
});
