import { describe, it, expect } from "vitest";
import { recomputeClientTotals, centsToDollarString, dollarStringToCents } from "./ncDorWorksheetMath";
import { computeNcDorFigures } from "./parties/ncDorSalesUse/calc";
import { deriveNcDorFigures } from "./parties/ncDorSalesUse/derive";

// Seeded to mirror the OLD hardcoded constants (NC_STATE_RATE / RATE_BY_LINE /
// NC_COUNTY_TIERS) so parity assertions below are unchanged from before the
// rateMap refactor.
const RATE_MAP: Record<string, number> = {
  nc_sales_state: 0.0475,
  nc_sales_line_4: 0.0475,
  nc_sales_line_5: 0.03,
  nc_sales_line_6: 0.0475,
  nc_sales_line_7: 0.0475,
  nc_sales_line_8: 0.02,
  nc_sales_line_9: 0.02,
  nc_sales_line_10: 0.0225,
  nc_sales_line_11: 0.005,
  nc_sales_line_12: 0.0025,
  nc_local_WAKE: 0.02,
  nc_transit_WAKE: 0.005,
  nc_local_DURHAM: 0.0225,
  nc_transit_DURHAM: 0.005,
};

describe("recomputeClientTotals", () => {
  // `lineN_tax` is now DERIVED from receipts + purchases (not passed in raw), so
  // these exercise the real client derivation: line4 @ 4.75%, line5 @ 3%.
  it("line13 = sum of derived tax across rate lines 4-12", () => {
    const next = recomputeClientTotals({ line4_receipts: 10000, line5_receipts: 10000 }, RATE_MAP);
    // line4_tax = round(10000 × 0.0475) = 475; line5_tax = round(10000 × 0.03) = 300
    expect(next.line4_tax).toBe(475);
    expect(next.line5_tax).toBe(300);
    expect(next.line13_total).toBe(775);
  });

  it("line15 = line13 + line14 (excess collections)", () => {
    const next = recomputeClientTotals({ line4_receipts: 10000, line14_excess: 250 }, RATE_MAP);
    expect(next.line13_total).toBe(475);
    expect(next.line15_total).toBe(725);
  });

  it("line21 adds penalty/interest/prepay_next and SUBTRACTS less_prepay/credit", () => {
    const next = recomputeClientTotals(
      {
        line4_receipts: 10000, // -> line4_tax 475
        line16_penalty: 50,
        line17_interest: 25,
        line19_prepay_next: 100,
        line18_less_prepay: 300,
        line20_credit: 75,
      },
      RATE_MAP,
    );
    // line13 = 475, line15 = 475 (no excess)
    // line21 = 475 + 50 + 25 + 100 - 300 - 75 = 275
    expect(next.line21_total_due).toBe(275);
  });

  it("line21 can go negative when prepay/credit exceed the tax due", () => {
    const next = recomputeClientTotals({ line4_receipts: 10000, line18_less_prepay: 5000 }, RATE_MAP);
    // line13 = 475; line21 = 475 - 5000 = -4525
    expect(next.line21_total_due).toBe(-4525);
  });

  it("preserves every other field (manual entries, strings) unchanged", () => {
    const next = recomputeClientTotals(
      {
        line4_receipts: 10000,
        line20_credit_explanation: "carryover",
        line2_sales_for_resale: 200,
      },
      RATE_MAP,
    );
    expect(next.line20_credit_explanation).toBe("carryover");
    expect(next.line2_sales_for_resale).toBe(200);
  });

  it("treats missing rate-line/adjustment fields as 0, not NaN", () => {
    const next = recomputeClientTotals({}, RATE_MAP);
    expect(next.line13_total).toBe(0);
    expect(next.line15_total).toBe(0);
    expect(next.line21_total_due).toBe(0);
  });

  it("an empty rateMap zeroes every derived tax (regression guard against ignoring the map — the loading guard must never call this with {})", () => {
    const next = recomputeClientTotals({ line4_receipts: 10000 }, {});
    expect(next.line4_tax).toBe(0);
    expect(next.line13_total).toBe(0);
  });

  it("a manual line9_purchases edit flows into line9_tax, the county row, and the totals", () => {
    const base = computeNcDorFigures(
      {
        taxableBaseCents: 100000,
        counties: [{ code: "WAKE", weight: 100 }],
        collectedGeneralTaxCents: 7250,
      },
      RATE_MAP,
    ).fields;
    const next = recomputeClientTotals({ ...base, line9_purchases: 50000 }, RATE_MAP);
    // line9_tax = round((50000 + 100000) × 0.02) = 3000
    expect(next.line9_tax).toBe(3000);
    expect(next.county_WAKE_2pct).toBe(3000);
    // +1000 vs baseline (7250) flows through
    expect(next.line13_total).toBe(8250);
    expect(next.line21_total_due).toBe(8250);
  });

  it("parity: the client recompute equals the engine derivation on a shared fixture", () => {
    const base = computeNcDorFigures(
      {
        taxableBaseCents: 137500,
        counties: [
          { code: "WAKE", weight: 60 },
          { code: "DURHAM", weight: 40 },
        ],
        collectedGeneralTaxCents: 0,
      },
      RATE_MAP,
    ).fields;
    // simulate a user typing purchases on both a state line and a county line
    const edited = { ...base, line4_purchases: 25000, line9_purchases: 15000 };
    const client = recomputeClientTotals(edited, RATE_MAP);
    const engine = deriveNcDorFigures(edited, RATE_MAP);
    expect(client).toEqual(engine);
    // and the county schedule reconciles to the page-1 line taxes, purchases included
    const n = (v: number | string | null | undefined) => Number(v ?? 0);
    expect(n(client.county_WAKE_2pct)).toBe(n(client.line9_tax));
    expect(n(client.county_DURHAM_225pct)).toBe(n(client.line10_tax));
    expect(n(client.county_WAKE_transit) + n(client.county_DURHAM_transit)).toBe(
      n(client.line11_tax) + n(client.line12_tax),
    );
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
