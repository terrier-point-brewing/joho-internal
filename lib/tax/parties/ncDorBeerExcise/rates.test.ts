import { describe, it, expect } from "vitest";
import { NC_EXCISE_RATE_MICROS_FALLBACK, TAXABLE_CHANNELS, usdToMicros, DISCOUNT_RATE } from "./rates";

describe("beer excise rates", () => {
  it("fallback micros match the statutory $0.6171/gal", () => {
    expect(NC_EXCISE_RATE_MICROS_FALLBACK).toBe(617100);
    expect(usdToMicros(0.6171)).toBe(617100);
  });
  it("taxes distribution/contract/taproom but not wholesale", () => {
    expect(TAXABLE_CHANNELS.has("distribution")).toBe(true);
    expect(TAXABLE_CHANNELS.has("contract_brewing")).toBe(true);
    expect(TAXABLE_CHANNELS.has("taproom")).toBe(true);
    expect(TAXABLE_CHANNELS.has("wholesale")).toBe(false);
  });
  it("discount is 2%", () => expect(DISCOUNT_RATE).toBe(0.02));
});
