import { describe, it, expect } from "vitest";
import {
  EM_DASH,
  formatBalanceCents,
  formatCurrency,
  formatCurrencyCents,
  formatNumber,
  formatPercent,
  formatUnitCost,
} from "./format";

describe("formatCurrencyCents", () => {
  it("divides cents by 100 and renders USD", () => {
    expect(formatCurrencyCents(1599)).toBe("$15.99");
  });

  it("renders exact zero as the em-dash sentinel (accounting style)", () => {
    expect(formatCurrencyCents(0)).toBe(EM_DASH);
  });

  it("renders negative cents in parentheses (accounting style)", () => {
    expect(formatCurrencyCents(-2500)).toBe("($25.00)");
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

describe("formatBalanceCents", () => {
  it("renders exact zero as $0.00, NOT the em-dash sentinel", () => {
    // The whole reason this formatter exists. A balance of zero was determined;
    // the sentinel is reserved for balances that were not.
    expect(formatBalanceCents(0)).toBe("$0.00");
    expect(formatBalanceCents(0)).not.toBe(EM_DASH);
  });

  it("renders negative zero as $0.00, never -$0.00", () => {
    expect(formatBalanceCents(-0)).toBe("$0.00");
  });

  it("keeps the sentinel for a balance that was never determined", () => {
    expect(formatBalanceCents(null)).toBe(EM_DASH);
    expect(formatBalanceCents(undefined)).toBe(EM_DASH);
    expect(formatBalanceCents(NaN)).toBe(EM_DASH);
    expect(formatBalanceCents(Infinity)).toBe(EM_DASH);
  });

  it("matches formatCurrencyCents everywhere except zero", () => {
    // Pins the divergence to zero alone. Anything else drifting apart would
    // mean a manual-entries screen quietly disagreeing with the balance sheet
    // about what a number looks like.
    for (const cents of [1599, -2500, 123456789, 1, -1, 0.5]) {
      expect(formatBalanceCents(cents), String(cents)).toBe(formatCurrencyCents(cents));
    }
    expect(formatBalanceCents(0)).not.toBe(formatCurrencyCents(0));
  });

  it("renders negatives in parentheses (accounting style)", () => {
    // Contra-accounts and credit-side balances are stored negative here, and
    // they mean the same thing on this screen as on any other.
    expect(formatBalanceCents(-2500)).toBe("($25.00)");
  });

  it("honours the decimal count at zero too", () => {
    expect(formatBalanceCents(0, 0)).toBe("$0");
    expect(formatBalanceCents(0, 3)).toBe("$0.000");
  });

  it("leaves formatCurrencyCents' zero behaviour alone", () => {
    // The statement formatter is shared with the verified P&L, cash-flow and
    // tax statements. Its zero-as-blank is deliberate and must not drift.
    expect(formatCurrencyCents(0)).toBe(EM_DASH);
  });
});

describe("formatCurrency", () => {
  it("renders dollars with two decimals by default", () => {
    expect(formatCurrency(15.99)).toBe("$15.99");
  });

  it("renders exact zero as the em-dash sentinel (accounting style)", () => {
    expect(formatCurrency(0)).toBe(EM_DASH);
  });

  it("renders negatives in parentheses (accounting style)", () => {
    expect(formatCurrency(-1.5)).toBe("($1.50)");
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

describe("formatUnitCost", () => {
  it("keeps at least two decimals for whole-cent costs", () => {
    expect(formatUnitCost(1.5)).toBe("$1.50");
    expect(formatUnitCost(2)).toBe("$2.00");
  });

  it("shows sub-cent precision up to four decimals", () => {
    expect(formatUnitCost(0.035)).toBe("$0.035");
    expect(formatUnitCost(0.1234)).toBe("$0.1234");
  });

  it("trims trailing zeros beyond the second decimal", () => {
    expect(formatUnitCost(0.035)).toBe("$0.035"); // not $0.0350
  });

  it("rounds precision beyond four decimals", () => {
    expect(formatUnitCost(0.12345)).toBe("$0.1235");
  });

  it("renders negatives in parentheses and zero/blank sentinels", () => {
    expect(formatUnitCost(-0.035)).toBe("($0.035)");
    expect(formatUnitCost(0)).toBe(EM_DASH);
    expect(formatUnitCost(null)).toBe(EM_DASH);
    expect(formatUnitCost(NaN)).toBe(EM_DASH);
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
