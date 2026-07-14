import { describe, it, expect } from "vitest";
import { resolveBeerFieldOwnership, isComputedField } from "./fieldOwnership";

describe("beer excise field ownership", () => {
  it.each(["gal_taxable","cents_excise_due","cents_total_payment_due","nc_excise_rate_micros","gal_produced_for_sale"])(
    "%s is computed", (k) => expect(resolveBeerFieldOwnership(k)).toBe("computed"));
  it.each(["cents_penalty","cents_interest","flag_timely","gal_ending_inventory","gal_adjustments_part3","signer_date"])(
    "%s is manual", (k) => expect(resolveBeerFieldOwnership(k)).toBe("manual"));
  it("unknown keys default to manual", () => expect(resolveBeerFieldOwnership("mystery")).toBe("manual"));
  it("isComputedField mirrors resolve", () => expect(isComputedField("gal_taxable")).toBe(true));
});
