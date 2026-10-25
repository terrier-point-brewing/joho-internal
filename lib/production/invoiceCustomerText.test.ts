import { describe, expect, it } from "vitest";
import {
  DEPOSIT_LINE_DESCRIPTION,
  catalogProductLineDescription,
  depositInvoiceDescription,
  depositInvoiceTitle,
  depositReductionRefundReason,
  exciseTaxLineDescription,
  exportInvoiceTitle,
  formatHalfBbl,
  formatSharePct,
  formatShippedBbl,
  ingredientCostLineDescription,
  packagingFeeLineDescription,
  packagingMaterialsLineDescription,
  unmappedProductLineDescription,
} from "./invoiceCustomerText";
import { isIngredientDepositLine } from "./depositLine";

const SHARE = { sharePct: 25, batchNumber: "B-063", turns: 2, beerName: "Epic Hazy IPA", projectedYieldBbl: 32 };

/**
 * Every customer-facing string, rendered with realistic inputs. The house
 * rule: a partner reads names and round numbers, never derivations. No
 * percentage with decimals, no volume beyond one decimal, and an estimate is
 * always labelled "Estimated".
 */
const SAMPLES: Record<string, string> = {
  exportTitle: exportInvoiceTitle("Fortnight Brewing"),
  depositTitle: depositInvoiceTitle("Epic Hazy IPA"),
  depositDescription: depositInvoiceDescription(SHARE),
  depositDescriptionUgly: depositInvoiceDescription({ ...SHARE, sharePct: 33.333333, projectedYieldBbl: 31.7 }),
  depositLine: DEPOSIT_LINE_DESCRIPTION,
  ingredientCost: ingredientCostLineDescription("Epic Hazy IPA", "B-063", 7),
  ingredientCostFraction: ingredientCostLineDescription(" Transfusion Pilsner ", "#B-051", 4.666),
  ingredientCostNoBatch: ingredientCostLineDescription("Transfusion Pilsner", null, 4),
  packagingFee: packagingFeeLineDescription("Packaging Fee", "Fortnight"),
  packagingFeeBare: packagingFeeLineDescription("Packaging Fee", null),
  materials: packagingMaterialsLineDescription("Fortnight"),
  materialsBare: packagingMaterialsLineDescription(null),
  exciseFederal: exciseTaxLineDescription("Federal", 7.5),
  exciseNc: exciseTaxLineDescription("NC", 4.666, "per_gallon"),
  catalogProduct: catalogProductLineDescription("Vienna Lager (Keg)", "1/6 Keg", "sixtel", "VAR-1"),
  catalogFallback: catalogProductLineDescription(null, null, null, "VAR-1"),
  unmappedProduct: unmappedProductLineDescription("Hop Roar IPA", "16oz Can", "case"),
  refundReason: depositReductionRefundReason({ ...SHARE, newSharePct: 10 }),
  refundReasonUgly: depositReductionRefundReason({ ...SHARE, sharePct: 33.333333, newSharePct: 12.5, projectedYieldBbl: 31.7 }),
};

describe("invoiceCustomerText — house rules", () => {
  it.each(Object.entries(SAMPLES))("%s prints no decimal percentage", (_name, text) => {
    expect(text).not.toMatch(/\d+\.\d+\s*%/);
  });

  it.each(Object.entries(SAMPLES))("%s prints no volume beyond one decimal", (_name, text) => {
    expect(text).not.toMatch(/\d+\.\d{2,}\s*(bbls?|barrels?|gal|gallons?)\b/i);
  });

  it.each(Object.entries(SAMPLES))("%s prints no toFixed(2)-style number", (_name, text) => {
    expect(text).not.toMatch(/\d+\.\d{2}\b/);
  });

  it.each(Object.entries(SAMPLES).filter(([, t]) => /\b(bbls?|gal)\b/.test(t)))(
    "%s labels any volume as shipped, taxed or estimated",
    (_name, text) => {
      expect(text).toMatch(/Estimated yield is \d+(\.5)? bbls?|\d+(\.\d)? bbl of .* shipped|\d+(\.\d)? (bbl|gal) taxed/);
    },
  );
});

describe("invoiceCustomerText — excise line", () => {
  it("names the taxed barrelage to one decimal", () => {
    expect(exciseTaxLineDescription("Federal", 7.5)).toBe("Excise Tax — Federal (7.5 bbl taxed)");
    expect(exciseTaxLineDescription("NC", 4.666)).toBe("Excise Tax — NC (4.7 bbl taxed)");
    expect(exciseTaxLineDescription("NC", 4.666, "per_gallon")).toBe("Excise Tax — NC (144.6 gal taxed)");
    expect(exciseTaxLineDescription("NC", 24.23, "per_gallon")).toBe("Excise Tax — NC (751.1 gal taxed)");
    expect(exciseTaxLineDescription("Federal", 8)).toBe("Excise Tax — Federal (8 bbl taxed)");
  });
});

describe("invoiceCustomerText — formatting", () => {
  it("rounds shares to whole percent and floors tiny shares at <1%", () => {
    expect(formatSharePct(33.333333)).toBe("33%");
    expect(formatSharePct(12.5)).toBe("13%");
    expect(formatSharePct(0.4)).toBe("<1%");
    expect(formatSharePct(0)).toBe("0%");
  });

  it("rounds estimates to the nearest half barrel", () => {
    expect(formatHalfBbl(8)).toBe("8 bbls");
    expect(formatHalfBbl(3.3)).toBe("3.5 bbls");
    expect(formatHalfBbl(7.74)).toBe("7.5 bbls");
    expect(formatHalfBbl(1.1)).toBe("1 bbl");
  });

  it("prints shipped volume to one decimal, dropping .0", () => {
    expect(formatShippedBbl(7)).toBe("7 bbl");
    expect(formatShippedBbl(4.666)).toBe("4.7 bbl");
    expect(formatShippedBbl(0.25)).toBe("0.3 bbl");
  });
});

describe("invoiceCustomerText — exact wording", () => {
  it("export title names the company", () => {
    expect(SAMPLES.exportTitle).toBe("Export Invoice — Fortnight Brewing");
  });

  it("deposit title names the beer; description is the owner's sentence", () => {
    expect(SAMPLES.depositTitle).toBe("Ingredient Deposit — Epic Hazy IPA");
    expect(SAMPLES.depositDescription).toBe(
      "Ingredient deposit for 25% of #B-063, a 2-turn batch of Epic Hazy IPA. Estimated yield is 8 bbls, final volume is confirmed at packaging.",
    );
    expect(SAMPLES.depositDescriptionUgly).toBe(
      "Ingredient deposit for 33% of #B-063, a 2-turn batch of Epic Hazy IPA. Estimated yield is 10.5 bbls, final volume is confirmed at packaging.",
    );
    expect(SAMPLES.depositLine).toBe("Ingredient Deposit");
  });

  it("ingredient cost line names shipped volume, beer and batch, keeps the prefix the router matches", () => {
    expect(SAMPLES.ingredientCost).toBe("Ingredient Cost — Ingredients used to produce the 7 bbl of Epic Hazy IPA shipped from #B-063");
    expect(SAMPLES.ingredientCostFraction).toBe("Ingredient Cost — Ingredients used to produce the 4.7 bbl of Transfusion Pilsner shipped from #B-051");
    expect(SAMPLES.ingredientCostNoBatch).toBe("Ingredient Cost — Ingredients used to produce the 4 bbl of Transfusion Pilsner shipped");
    expect(isIngredientDepositLine({ description: SAMPLES.ingredientCost, squareCatalogVariationId: "v" })).toBe(true);
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

  it("refund reason is the owner's sentence with the NEW share's estimate", () => {
    expect(SAMPLES.refundReason).toBe(
      "Partial adjustment of previous deposit for 25% of #B-063, a 2-turn batch of Epic Hazy IPA. Refund drops allocation from 25% to 10%. Estimated yield is 3 bbls, final volume is confirmed at packaging.",
    );
    expect(SAMPLES.refundReasonUgly).toBe(
      "Partial adjustment of previous deposit for 33% of #B-063, a 2-turn batch of Epic Hazy IPA. Refund drops allocation from 33% to 13%. Estimated yield is 4 bbls, final volume is confirmed at packaging.",
    );
  });
});
