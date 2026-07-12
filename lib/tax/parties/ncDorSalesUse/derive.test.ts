import { describe, it, expect } from "vitest";
import {
  allocateByWeights,
  computeDependentTotals,
  deriveNcDorFigures,
} from "./derive";
import { computeNcDorFigures } from "./calc";

const n = (v: number | string | null | undefined) => Number(v ?? 0);

describe("allocateByWeights", () => {
  it("splits by weight, summing exactly to the total (largest-remainder, tie -> first)", () => {
    const alloc = allocateByWeights(100001, [50, 50]);
    expect(alloc).toEqual([50001, 50000]);
    expect(alloc[0] + alloc[1]).toBe(100001);
  });

  it("splits proportionally by unequal weights", () => {
    expect(allocateByWeights(1000, [75, 25])).toEqual([750, 250]);
  });

  it("returns zeros for a zero total", () => {
    expect(allocateByWeights(0, [50, 50])).toEqual([0, 0]);
  });

  it("spreads evenly (never drops the amount) when all weights are zero", () => {
    expect(allocateByWeights(10, [0, 0, 0])).toEqual([4, 3, 3]);
  });

  it("returns an empty array for no members", () => {
    expect(allocateByWeights(100, [])).toEqual([]);
  });
});

describe("computeDependentTotals", () => {
  it("flows manual penalty/interest/credit into line21", () => {
    const totals = computeDependentTotals({
      line4_tax: 4750,
      line9_tax: 2000,
      line11_tax: 500,
      line16_penalty: 100,
      line17_interest: 25,
      line18_less_prepay: 200,
      line20_credit: 50,
    });
    expect(totals.line13_total).toBe(7250);
    expect(totals.line15_total).toBe(7250);
    expect(totals.line21_total_due).toBe(7125);
  });
});

// The realistic flow: initial Square compute (purchases 0) → the user enters a
// manual `lineN_purchases` → the shared derivation re-derives tax + totals.
describe("deriveNcDorFigures — purchases for use flow into line tax", () => {
  it("single county Wake: line9_purchases flows into line9_tax, county row, line13 & line21", () => {
    const base = computeNcDorFigures({
      taxableBaseCents: 100000,
      counties: [{ code: "WAKE", weight: 100 }],
      collectedGeneralTaxCents: 7250,
    }).fields;
    // baseline (purchases 0)
    expect(base.line9_tax).toBe(2000);
    expect(base.line13_total).toBe(7250);
    expect(base.line21_total_due).toBe(7250);

    const f = deriveNcDorFigures({ ...base, line9_purchases: 50000 });
    // line9_tax = round((50000 + 100000) × 0.02) = 3000
    expect(f.line9_tax).toBe(3000);
    // page-2 county row reconciles to the page-1 line, purchases included
    expect(f.county_WAKE_2pct).toBe(3000);
    // +1000 vs the no-purchases case flows through line13 and line21
    expect(f.line13_total).toBe(8250);
    expect(f.line21_total_due).toBe(8250);
    // untouched lines unchanged
    expect(f.line4_tax).toBe(4750);
    expect(f.line11_tax).toBe(500);
  });

  it("state line 4: line4_purchases flows into line4_tax and the totals", () => {
    const base = computeNcDorFigures({
      taxableBaseCents: 100000,
      counties: [{ code: "WAKE", weight: 100 }],
      collectedGeneralTaxCents: 7250,
    }).fields;

    const f = deriveNcDorFigures({ ...base, line4_purchases: 10000 });
    // line4_tax = round((10000 + 100000) × 0.0475) = 5225
    expect(f.line4_tax).toBe(Math.round((10000 + 100000) * 0.0475));
    expect(f.line4_tax).toBe(5225);
    // +475 vs baseline (4750) flows to line13/line21
    expect(f.line13_total).toBe(7250 + 475);
    expect(f.line21_total_due).toBe(7250 + 475);
  });

  it("multi-county (Wake 50 / Durham 50): line9_purchases splits across the 2%-counties by weight; county rows reconcile", () => {
    // Two counties on DIFFERENT local lines (Wake→9, Durham→10). Add a third
    // 2%-county (Mecklenburg) so line 9 has two members and the split matters.
    const base = computeNcDorFigures({
      taxableBaseCents: 100000,
      counties: [
        { code: "WAKE", weight: 50 },
        { code: "MECKLENBURG", weight: 50 },
      ],
      collectedGeneralTaxCents: 0,
    }).fields;
    // both 2% local → both on line 9, each receipts 50000
    expect(base.line9_tax).toBe(2000);

    const f = deriveNcDorFigures({ ...base, line9_purchases: 40000 });
    // 40000 split 50/50 → 20000 each. Each county row = round((50000+20000)×0.02) = 1400
    expect(f.county_WAKE_2pct).toBe(1400);
    expect(f.county_MECKLENBURG_2pct).toBe(1400);
    // line9_tax = sum of the county rows = 2800 = round((100000+40000)×0.02)
    expect(f.line9_tax).toBe(2800);
    // reconciliation: Σ county 2pct rows === line9_tax
    expect(n(f.county_WAKE_2pct) + n(f.county_MECKLENBURG_2pct)).toBe(n(f.line9_tax));
  });

  it("multi-county with an odd purchases split still reconciles Σ county rows === line tax", () => {
    const base = computeNcDorFigures({
      taxableBaseCents: 100000,
      counties: [
        { code: "WAKE", weight: 50 },
        { code: "MECKLENBURG", weight: 50 },
      ],
      collectedGeneralTaxCents: 0,
    }).fields;
    const f = deriveNcDorFigures({ ...base, line9_purchases: 33333 });
    expect(n(f.county_WAKE_2pct) + n(f.county_MECKLENBURG_2pct)).toBe(n(f.line9_tax));
    // transit line 11 (both Wake & Meck are 0.5% transit) still reconciles
    expect(n(f.county_WAKE_transit) + n(f.county_MECKLENBURG_transit)).toBe(n(f.line11_tax));
  });

  it("purchases = 0 is a pure pass-through of the initial compute (regression)", () => {
    const computed = computeNcDorFigures({
      taxableBaseCents: 100000,
      counties: [
        { code: "WAKE", weight: 50 },
        { code: "DURHAM", weight: 50 },
      ],
      collectedGeneralTaxCents: 7375,
    }).fields;
    const redived = deriveNcDorFigures({ ...computed });
    expect(redived).toEqual(computed);
  });
});
