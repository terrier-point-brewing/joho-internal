import { describe, it, expect } from "vitest";
import { recomputeClientBeerTotals, gallonsToString, stringToGallons } from "./beerExciseWorksheetMath";

describe("beer worksheet client math", () => {
  it("recompute mirrors server derive", () => {
    const f = recomputeClientBeerTotals({
      gal_distribution: 1000,
      gal_contract: 0,
      gal_taproom: 0,
      gal_wholesale: 0,
      flag_timely: 1,
      nc_excise_rate_micros: 617100,
    });
    expect(f.gal_taxable).toBe(1000);
    expect(f.cents_excise_due).toBe(Math.round(1000 * 61.71));
  });

  it("gallon string round-trips as whole gallons", () => {
    expect(gallonsToString(310)).toBe("310");
    expect(stringToGallons("310.7")).toBe(311);
    expect(stringToGallons("")).toBe(0);
  });
});
