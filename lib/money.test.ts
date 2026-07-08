import { describe, it, expect, expectTypeOf } from "vitest";
import {
  type Cents,
  type Dollars,
  dollarsToCents,
  centsToDollars,
  cents,
  dollars,
} from "./money";

describe("dollarsToCents", () => {
  it("rounds to the nearest whole cent", () => {
    // 0.6171 dollars → 61.71 cents → Math.round → 62 cents
    expect(dollarsToCents(0.6171)).toBe(62);
  });

  it("rounds half away from zero via Math.round", () => {
    expect(dollarsToCents(0.005)).toBe(1); // 0.5 cents → 1
    expect(dollarsToCents(0.004)).toBe(0); // 0.4 cents → 0
  });

  it("converts exact dollar amounts", () => {
    expect(dollarsToCents(15.99)).toBe(1599);
    expect(dollarsToCents(0)).toBe(0);
  });

  it("handles negative amounts", () => {
    expect(dollarsToCents(-25)).toBe(-2500);
  });
});

describe("centsToDollars", () => {
  it("divides cents by 100", () => {
    expect(centsToDollars(1599)).toBe(15.99);
    expect(centsToDollars(0)).toBe(0);
    expect(centsToDollars(-2500)).toBe(-25);
  });

  it("round-trips with dollarsToCents at cent precision", () => {
    expect(centsToDollars(dollarsToCents(38.29))).toBe(38.29);
  });
});

describe("branded constructors", () => {
  it("brand without changing the numeric value", () => {
    expect(cents(1599)).toBe(1599);
    expect(dollars(15.99)).toBe(15.99);
  });
});

describe("branded types (compile-time)", () => {
  it("dollarsToCents returns Cents and centsToDollars returns Dollars", () => {
    expectTypeOf(dollarsToCents(1)).toEqualTypeOf<Cents>();
    expectTypeOf(centsToDollars(1)).toEqualTypeOf<Dollars>();
    expectTypeOf(cents(1)).toEqualTypeOf<Cents>();
    expectTypeOf(dollars(1)).toEqualTypeOf<Dollars>();
    // A Cents and a Dollars are distinct brands, not assignable to each other.
    expectTypeOf<Cents>().not.toEqualTypeOf<Dollars>();
  });
});
