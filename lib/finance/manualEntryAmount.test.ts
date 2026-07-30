import { describe, it, expect } from "vitest";
import { formatAmountInput, parseAmountInputCents, daysInclusive, perDayCents } from "./manualEntryAmount";

describe("parseAmountInputCents", () => {
  it("parses a plain positive amount", () => {
    expect(parseAmountInputCents("15.99")).toBe(1599);
  });

  it("parses a negative amount", () => {
    expect(parseAmountInputCents("-1250.00")).toBe(-125000);
  });

  it("ignores thousands separators", () => {
    expect(parseAmountInputCents("1,234.56")).toBe(123456);
    expect(parseAmountInputCents("-1,234.56")).toBe(-123456);
  });

  it("rounds partial cents", () => {
    expect(parseAmountInputCents("1.129")).toBe(113);
  });

  it("treats zero as invalid (amountCents must not be zero)", () => {
    expect(parseAmountInputCents("0")).toBeNull();
    expect(parseAmountInputCents("0.00")).toBeNull();
    expect(parseAmountInputCents("-0")).toBeNull();
  });

  it("returns null for empty/unparseable input", () => {
    expect(parseAmountInputCents("")).toBeNull();
    expect(parseAmountInputCents("   ")).toBeNull();
    expect(parseAmountInputCents("-")).toBeNull();
    expect(parseAmountInputCents("abc")).toBeNull();
  });

  it("treats an integer with no decimal as whole dollars", () => {
    expect(parseAmountInputCents("500")).toBe(50000);
  });
});

describe("formatAmountInput", () => {
  it("adds thousands separators", () => {
    expect(formatAmountInput("1234")).toBe("1,234");
    expect(formatAmountInput("1234567.89")).toBe("1,234,567.89");
  });

  it("preserves a leading negative sign", () => {
    expect(formatAmountInput("-1234.5")).toBe("-1,234.5");
    expect(formatAmountInput("-")).toBe("-");
  });

  it("truncates to two decimal places while typing", () => {
    expect(formatAmountInput("12.345")).toBe("12.34");
  });

  it("returns empty string for empty input", () => {
    expect(formatAmountInput("")).toBe("");
  });
});

describe("daysInclusive", () => {
  it("counts a single day as 1", () => {
    expect(daysInclusive("2026-01-15", "2026-01-15")).toBe(1);
  });

  it("counts a full month inclusive of both ends", () => {
    expect(daysInclusive("2026-01-01", "2026-01-31")).toBe(31);
  });

  it("handles a range spanning a month boundary", () => {
    expect(daysInclusive("2026-01-30", "2026-02-02")).toBe(4);
  });
});

describe("perDayCents", () => {
  it("splits evenly across days", () => {
    expect(perDayCents(10000, 4)).toBe(2500);
  });

  it("rounds a non-even split", () => {
    expect(perDayCents(10000, 3)).toBe(3333);
  });

  it("carries the sign of a negative amount", () => {
    expect(perDayCents(-10000, 4)).toBe(-2500);
  });

  it("falls back to the raw amount when days is 0", () => {
    expect(perDayCents(500, 0)).toBe(500);
  });
});
