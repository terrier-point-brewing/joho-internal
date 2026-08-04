import { describe, it, expect } from "vitest";
import { summariseSyncDiscrepancies } from "./inventoryDrift";

describe("summariseSyncDiscrepancies", () => {
  it("renders an unbooked sale with its quantity", () => {
    expect(
      summariseSyncDiscrepancies([
        { kind: "unmapped_sale", squareVariationId: "SQ-1", quantity: 23, days: ["2026-07-01"] },
      ]),
    ).toEqual([
      { kind: "unmapped_sale", detail: expect.stringContaining("23 sold on Square variation SQ-1") },
    ]);
  });

  it("renders a link with no cold-storage variation behind it", () => {
    expect(
      summariseSyncDiscrepancies([
        { kind: "link_missing_cold_storage_variation", recipeId: "R1", beerName: "Vienna Lager", variationName: "1/6 Keg" },
      ]),
    ).toEqual([
      { kind: "link_missing_cold_storage_variation", detail: expect.stringContaining("Vienna Lager · 1/6 Keg") },
    ]);
  });

  // Operational noise (short stock, failed recounts, shrinkage) belongs in the
  // cron detail, not in a banner about mappings being wrong.
  it("keeps non-mapping discrepancies out", () => {
    expect(
      summariseSyncDiscrepancies([
        { kind: "short_stock", recipeId: "R1", shortfallQty: 4 },
        { kind: "recount_failed", sourceRef: "x", detail: "boom" },
        { kind: "restock_overdraft", overdraftFlOz: 12 },
      ]),
    ).toEqual([]);
  });

  it("keeps mapping findings and drops the rest from a mixed run", () => {
    const out = summariseSyncDiscrepancies([
      { kind: "short_stock", recipeId: "R1" },
      { kind: "unmapped_restock", squareVariationId: "SQ-9", count: 2 },
      { kind: "shrinkage_capture_failed", sourceRef: "y" },
      { kind: "unconfigured_draft_swap", recipeId: "R2", beerName: "Porter", swapCount: 1 },
    ]);
    expect(out.map((o) => o.kind)).toEqual(["unmapped_restock", "unconfigured_draft_swap"]);
  });

  it("falls back to the recipe id when a beer name is missing", () => {
    const [out] = summariseSyncDiscrepancies([
      { kind: "unconfigured_draft_swap", recipeId: "R-abc", beerName: "", swapCount: 3 },
    ]);
    expect(out.detail).toContain("R-abc");
  });

  it("returns nothing for an empty run", () => {
    expect(summariseSyncDiscrepancies([])).toEqual([]);
  });
});
