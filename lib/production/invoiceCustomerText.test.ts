import { describe, expect, it } from "vitest";
import {
  DEPOSIT_LINE_DESCRIPTION,
  DEPOSIT_REDUCED_REFUND_REASON,
  catalogProductLineDescription,
  depositInvoiceDescription,
  depositInvoiceTitle,
  exciseTaxLineDescription,
  exportInvoiceTitle,
  ingredientCostLineDescription,
  packagingFeeLineDescription,
  packagingMaterialsLineDescription,
  unmappedProductLineDescription,
} from "./invoiceCustomerText";
import { isIngredientDepositLine } from "./depositLine";

/**
 * Every customer-facing string, rendered with realistic inputs. The house
 * rule: a partner reads names, never derivations. No percentage with
 * decimals, no bbl/gallon figure, no "x.xx" number that reads as a promise.
 */
const SAMPLES: Record<string, string> = {
  exportTitle: exportInvoiceTitle("Fortnight Brewing"),
  depositTitle: depositInvoiceTitle("Transfusion Pilsner"),
  depositDescription: depositInvoiceDescription("Transfusion Pilsner"),
  depositLine: DEPOSIT_LINE_DESCRIPTION,
  ingredientCost: ingredientCostLineDescription("Transfusion Pilsner", "B-051"),
  ingredientCostNoBatch: ingredientCostLineDescription(" Transfusion Pilsner ", null),
  packagingFee: packagingFeeLineDescription("Packaging Fee", "Fortnight"),
  packagingFeeBare: packagingFeeLineDescription("Packaging Fee", null),
  materials: packagingMaterialsLineDescription("Fortnight"),
  materialsBare: packagingMaterialsLineDescription(null),
  exciseFederal: exciseTaxLineDescription("Federal"),
  exciseNc: exciseTaxLineDescription("NC"),
  catalogProduct: catalogProductLineDescription("Vienna Lager (Keg)", "1/6 Keg", "sixtel", "VAR-1"),
  catalogFallback: catalogProductLineDescription(null, null, null, "VAR-1"),
  unmappedProduct: unmappedProductLineDescription("Hop Roar IPA", "16oz Can", "case"),
  refundReason: DEPOSIT_REDUCED_REFUND_REASON,
};

describe("invoiceCustomerText — house rules", () => {
  it.each(Object.entries(SAMPLES))("%s prints no decimal percentage", (_name, text) => {
    expect(text).not.toMatch(/\d+\.\d+\s*%/);
  });

  it.each(Object.entries(SAMPLES))("%s prints no volume figure", (_name, text) => {
    expect(text).not.toMatch(/\d+(\.\d+)?\s*(bbl|barrels?|gal|gallons?)\b/i);
  });

  it.each(Object.entries(SAMPLES))("%s prints no toFixed-style number", (_name, text) => {
    expect(text).not.toMatch(/\d+\.\d{2}\b/);
  });
});

describe("invoiceCustomerText — exact wording", () => {
  it("export title names the company", () => {
    expect(SAMPLES.exportTitle).toBe("Export Invoice — Fortnight Brewing");
  });

  it("deposit title and description name the beer and nothing else", () => {
    expect(SAMPLES.depositTitle).toBe("Ingredient Deposit — Transfusion Pilsner");
    expect(SAMPLES.depositDescription).toBe("Ingredient deposit for your Transfusion Pilsner batch.");
    expect(SAMPLES.depositLine).toBe("Ingredient Deposit");
  });

  it("ingredient cost line names beer and batch, keeps the prefix the router matches", () => {
    expect(SAMPLES.ingredientCost).toBe("Ingredient Cost — Transfusion Pilsner (batch B-051)");
    expect(SAMPLES.ingredientCostNoBatch).toBe("Ingredient Cost — Transfusion Pilsner");
    expect(isIngredientDepositLine({ description: SAMPLES.ingredientCost, squareCatalogVariationId: "v" })).toBe(true);
  });

  it("excise line names the receiving party only", () => {
    expect(SAMPLES.exciseFederal).toBe("Excise Tax — Federal");
    expect(SAMPLES.exciseNc).toBe("Excise Tax — NC");
  });

  it("fee and materials lines carry the beer when there is one", () => {
    expect(SAMPLES.packagingFee).toBe("Packaging Fee — Fortnight");
    expect(SAMPLES.packagingFeeBare).toBe("Packaging Fee");
    expect(SAMPLES.materials).toBe("Packaging Materials — Fortnight");
    expect(SAMPLES.materialsBare).toBe("Packaging Materials");
  });

  it("product lines read item · variation (format)", () => {
    expect(SAMPLES.catalogProduct).toBe("Vienna Lager (Keg) · 1/6 Keg (sixtel)");
    expect(SAMPLES.catalogFallback).toBe("VAR-1");
    expect(SAMPLES.unmappedProduct).toBe("Hop Roar IPA · 16oz Can (case)");
  });

  it("refund reason carries no percentages", () => {
    expect(SAMPLES.refundReason).toBe("Deposit adjusted — allocation reduced");
  });
});
