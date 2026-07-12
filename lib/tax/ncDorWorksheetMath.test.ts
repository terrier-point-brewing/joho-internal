import { describe, it, expect } from "vitest";
import { recomputeClientTotals, centsToDollarString, dollarStringToCents } from "./ncDorWorksheetMath";

describe("recomputeClientTotals", () => {
  it("line13 = sum of tax across rate lines 4-12", () => {
    const next = recomputeClientTotals({
      line4_tax: 475,
      line9_tax: 200,
      line11_tax: 50,
    });
    expect(next.line13_total).toBe(725);
  });

  it("line15 = line13 + line14 (excess collections)", () => {
    const next = recomputeClientTotals({ line4_tax: 1000, line14_excess: 250 });
    expect(next.line13_total).toBe(1000);
    expect(next.line15_total).toBe(1250);
  });

  it("line21 adds penalty/interest/prepay_next and SUBTRACTS less_prepay/credit", () => {
    const next = recomputeClientTotals({
      line4_tax: 1000,
      line16_penalty: 50,
      line17_interest: 25,
      line19_prepay_next: 100,
      line18_less_prepay: 300,
      line20_credit: 75,
    });
    // line13 = 1000, line15 = 1000 (no excess)
    // line21 = 1000 + 50 + 25 + 100 - 300 - 75 = 800
    expect(next.line21_total_due).toBe(800);
  });

  it("line21 can go negative when prepay/credit exceed the tax due", () => {
    const next = recomputeClientTotals({ line4_tax: 100, line18_less_prepay: 500 });
    expect(next.line21_total_due).toBe(-400);
  });

  it("preserves every other field (manual entries, strings) unchanged", () => {
    const next = recomputeClientTotals({
      line4_tax: 500,
      line20_credit_explanation: "carryover",
      line2_sales_for_resale: 200,
    });
    expect(next.line20_credit_explanation).toBe("carryover");
    expect(next.line2_sales_for_resale).toBe(200);
  });

  it("treats missing rate-line/adjustment fields as 0, not NaN", () => {
    const next = recomputeClientTotals({});
    expect(next.line13_total).toBe(0);
    expect(next.line15_total).toBe(0);
    expect(next.line21_total_due).toBe(0);
  });
});

describe("centsToDollarString", () => {
  it("formats cents as a fixed 2-decimal dollar string", () => {
    expect(centsToDollarString(12345)).toBe("123.45");
    expect(centsToDollarString(-500)).toBe("-5.00");
    expect(centsToDollarString(0)).toBe("0.00");
  });

  it("treats null/undefined as zero", () => {
    expect(centsToDollarString(null)).toBe("0.00");
    expect(centsToDollarString(undefined)).toBe("0.00");
  });

  it("parses a numeric-string field value defensively", () => {
    expect(centsToDollarString("2500")).toBe("25.00");
  });

  it("falls back to zero for non-finite input", () => {
    expect(centsToDollarString("not a number")).toBe("0.00");
    expect(centsToDollarString(NaN)).toBe("0.00");
  });
});

describe("dollarStringToCents", () => {
  it("treats blank or partial input as 0, not NaN", () => {
    expect(dollarStringToCents("")).toBe(0);
    expect(dollarStringToCents("  ")).toBe(0);
    expect(dollarStringToCents("-")).toBe(0);
    expect(dollarStringToCents(".")).toBe(0);
  });

  it("treats non-numeric input as 0", () => {
    expect(dollarStringToCents("abc")).toBe(0);
  });

  it("parses positive and negative dollar amounts", () => {
    expect(dollarStringToCents("123.45")).toBe(12345);
    expect(dollarStringToCents("-5.00")).toBe(-500);
  });

  it("rounds to the nearest cent", () => {
    expect(dollarStringToCents("10.004")).toBe(1000);
    expect(dollarStringToCents("10.006")).toBe(1001);
  });
});

describe("centsToDollarString / dollarStringToCents round-trip", () => {
  it.each([0, 1, -1, 100, -100, 999, 123456, -123456])("round-trips %i cents", (c) => {
    expect(dollarStringToCents(centsToDollarString(c))).toBe(c);
  });
});
