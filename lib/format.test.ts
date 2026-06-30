import { describe, it, expect } from "vitest";
import {
  EM_DASH,
  formatCurrency,
  formatCurrencyCents,
  formatNumber,
  formatPercent,
} from "./format";

describe("formatCurrencyCents", () => {
  it("divides cents by 100 and renders USD", () => {
    expect(formatCurrencyCents(1599)).toBe("$15.99");
  });

  it("renders zero as $0.00", () => {
    expect(formatCurrencyCents(0)).toBe("$0.00");
  });

  it("renders negative cents", () => {
    expect(formatCurrencyCents(-2500)).toBe("-$25.00");
  });

  it("respects a 0-decimal whole-dollar display (rounds)", () => {
    expect(formatCurrencyCents(1650, 0)).toBe("$17");
    expect(formatCurrencyCents(1649, 0)).toBe("$16");
  });

  it("rounds at the half-cent boundary (banker's-agnostic Intl rounding)", () => {
    // 0.005 dollars: Intl rounds half away from zero → $0.01
    expect(formatCurrencyCents(0.5)).toBe("$0.01");
  });

  it("groups thousands", () => {
    expect(formatCurrencyCents(123456789)).toBe("$1,234,567.89");
  });

  it("returns EM_DASH for null", () => {
    expect(formatCurrencyCents(null)).toBe(EM_DASH);
  });

  it("returns EM_DASH for undefined", () => {
    expect(formatCurrencyCents(undefined)).toBe(EM_DASH);
  });

  it("returns EM_DASH for NaN", () => {
    expect(formatCurrencyCents(NaN)).toBe(EM_DASH);
  });

  it("returns EM_DASH for Infinity", () => {
    expect(formatCurrencyCents(Infinity)).toBe(EM_DASH);
  });
});

describe("formatCurrency", () => {
  it("renders dollars with two decimals by default", () => {
    expect(formatCurrency(15.99)).toBe("$15.99");
  });

  it("renders zero", () => {
    expect(formatCurrency(0)).toBe("$0.00");
  });

  it("renders negatives", () => {
    expect(formatCurrency(-1.5)).toBe("-$1.50");
  });

  it("supports a 0-decimal display", () => {
    expect(formatCurrency(16.4, 0)).toBe("$16");
    expect(formatCurrency(16.5, 0)).toBe("$17");
  });

  it("pads to the requested decimal places", () => {
    expect(formatCurrency(3, 3)).toBe("$3.000");
  });

  it("returns EM_DASH for null / undefined / NaN / Infinity", () => {
    expect(formatCurrency(null)).toBe(EM_DASH);
    expect(formatCurrency(undefined)).toBe(EM_DASH);
    expect(formatCurrency(NaN)).toBe(EM_DASH);
    expect(formatCurrency(-Infinity)).toBe(EM_DASH);
  });
});

describe("formatNumber", () => {
  it("defaults to 0 decimals and rounds", () => {
    expect(formatNumber(1234.5)).toBe("1,235");
    expect(formatNumber(1234.4)).toBe("1,234");
  });

  it("respects a decimal count", () => {
    expect(formatNumber(1234.5, 1)).toBe("1,234.5");
  });

  it("renders zero", () => {
    expect(formatNumber(0)).toBe("0");
  });

  it("renders negatives with grouping", () => {
    expect(formatNumber(-1234567)).toBe("-1,234,567");
  });

  it("returns EM_DASH for null / undefined / NaN", () => {
    expect(formatNumber(null)).toBe(EM_DASH);
    expect(formatNumber(undefined)).toBe(EM_DASH);
    expect(formatNumber(NaN)).toBe(EM_DASH);
  });
});

describe("formatPercent", () => {
  it("multiplies the ratio by 100 with one decimal by default", () => {
    expect(formatPercent(0.15)).toBe("15.0%");
  });

  it("renders zero", () => {
    expect(formatPercent(0)).toBe("0.0%");
  });

  it("renders 100% from a ratio of 1", () => {
    expect(formatPercent(1)).toBe("100.0%");
  });

  it("respects a custom decimal count", () => {
    expect(formatPercent(0.12345, 2)).toBe("12.35%");
    expect(formatPercent(0.5, 0)).toBe("50%");
  });

  it("renders negatives", () => {
    expect(formatPercent(-0.05)).toBe("-5.0%");
  });

  it("returns EM_DASH for null / undefined / NaN / Infinity", () => {
    expect(formatPercent(null)).toBe(EM_DASH);
    expect(formatPercent(undefined)).toBe(EM_DASH);
    expect(formatPercent(NaN)).toBe(EM_DASH);
    expect(formatPercent(Infinity)).toBe(EM_DASH);
  });
});

describe("EM_DASH", () => {
  it("is the em-dash sentinel character", () => {
    expect(EM_DASH).toBe("—");
  });
});
