import { describe, it, expect } from "vitest";
import { rowBbl, amountPerBbl } from "./volume";
import { CATEGORY_IDS } from "@/lib/constants/categories";

const KEG_CAT = [...CATEGORY_IDS.KEGS][0];
const CAN_CAT = [...CATEGORY_IDS.CANS][0];
const DRAFT_CAT = [...CATEGORY_IDS.DRAFT][0];
const MERCH_CAT = [...CATEGORY_IDS.MERCHANDISE][0];

describe("rowBbl", () => {
  it("invoice row with explicit volume_bbl -> full coverage, used directly", () => {
    expect(rowBbl({ kind: "invoice", volumeBbl: 1.5 })).toEqual({ bbl: 1.5, coverage: "full" });
  });

  it("taproom beer row with unparseable BBL (no kegSize, no variationName) -> unknown", () => {
    const result = rowBbl({
      kind: "taproom",
      categoryId: KEG_CAT,
      kegSize: null,
      variationName: null,
      quantity: 1,
    });
    expect(result).toEqual({ bbl: 0, coverage: "unknown" });
  });

  it("non-beer row (merch) -> bbl 0, full coverage (not flagged as unknown)", () => {
    const result = rowBbl({
      kind: "taproom",
      categoryId: MERCH_CAT,
      kegSize: null,
      variationName: "T-Shirt",
      quantity: 1,
    });
    expect(result).toEqual({ bbl: 0, coverage: "full" });
  });

  it("full-coverage keg row (half keg) derives real BBL", () => {
    const result = rowBbl({
      kind: "taproom",
      categoryId: KEG_CAT,
      kegSize: "half",
      variationName: "1/2 Keg",
      quantity: 1,
    });
    expect(result.coverage).toBe("full");
    expect(result.bbl).toBeCloseTo(15.5 / 31, 10);
  });

  it("full-coverage can row derives real BBL from canOzPerUnit", () => {
    const result = rowBbl({
      kind: "taproom",
      categoryId: CAN_CAT,
      kegSize: "can",
      variationName: "16oz 4-Pack",
      quantity: 1,
    });
    expect(result.coverage).toBe("full");
    expect(result.bbl).toBeCloseTo((16 * 4) / 3968, 10);
  });

  it("by-the-glass DRAFT row derives real BBL from parseFlOz, even with no kegSize token", () => {
    const result = rowBbl({
      kind: "taproom",
      categoryId: DRAFT_CAT,
      kegSize: null,
      variationName: "Draft - 16oz",
      quantity: 3,
    });
    expect(result.coverage).toBe("full");
    expect(result.bbl).toBeCloseTo((16 * 3) / 3968, 10);
  });

  it("DRAFT row with bare '16oz' variation name still parses fl oz correctly", () => {
    const result = rowBbl({
      kind: "taproom",
      categoryId: DRAFT_CAT,
      kegSize: null,
      variationName: "16oz",
      quantity: 2,
    });
    expect(result.coverage).toBe("full");
    expect(result.bbl).toBeCloseTo((16 * 2) / 3968, 10);
  });

  it("DRAFT row with no variationName stays unknown (genuine gap, still flagged)", () => {
    const result = rowBbl({
      kind: "taproom",
      categoryId: DRAFT_CAT,
      kegSize: null,
      variationName: null,
      quantity: 1,
    });
    expect(result).toEqual({ bbl: 0, coverage: "unknown" });
  });

  it("CANS-category row derives real BBL by category even when kegSize is null (name lacks the literal word 'can')", () => {
    const result = rowBbl({
      kind: "taproom",
      categoryId: CAN_CAT,
      kegSize: null,
      variationName: "16oz 4-Pack",
      quantity: 1,
    });
    expect(result.coverage).toBe("full");
    expect(result.bbl).toBeCloseTo((16 * 4) / 3968, 10);
  });
});

describe("amountPerBbl", () => {
  it("unknown coverage -> null value, flagged, never divides", () => {
    expect(amountPerBbl(10000, 0, "unknown")).toEqual({ valueCents: null, flagged: true });
  });

  it("partial coverage -> null value, flagged", () => {
    expect(amountPerBbl(10000, 2, "partial")).toEqual({ valueCents: null, flagged: true });
  });

  it("full coverage with bbl <= 0 -> null value, flagged (no divide-by-zero)", () => {
    expect(amountPerBbl(10000, 0, "full")).toEqual({ valueCents: null, flagged: true });
  });

  it("full coverage with positive bbl -> real rounded $/BBL, not flagged", () => {
    expect(amountPerBbl(10000, 0.5, "full")).toEqual({ valueCents: 20000, flagged: false });
  });

  it("full coverage rounds to nearest cent", () => {
    expect(amountPerBbl(1000, 3, "full")).toEqual({ valueCents: 333, flagged: false });
  });
});
