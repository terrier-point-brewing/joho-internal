import { describe, it, expect } from "vitest";
import { isIngredientDepositLine } from "./depositLine";

describe("isIngredientDepositLine", () => {
  it("matches the current wording and the wording on older invoices", () => {
    expect(isIngredientDepositLine({ description: "Ingredient Cost — Hop Roar IPA, batch B-059: for the 5.17 bbl on this invoice", squareCatalogVariationId: "v1" })).toBe(true);
    expect(isIngredientDepositLine({ description: "Ingredient Deposit — Hop Roar IPA", squareCatalogVariationId: "v1" })).toBe(true);
  });

  it("ignores a free-text line and unrelated lines", () => {
    expect(isIngredientDepositLine({ description: "Ingredient Cost — typed by hand", squareCatalogVariationId: null })).toBe(false);
    expect(isIngredientDepositLine({ description: "Packaging Fee — Hop Roar IPA", squareCatalogVariationId: "v1" })).toBe(false);
  });
});
