import { describe, it, expect } from "vitest";
import { deriveBeerExciseFigures } from "./derive";

const base = {
  gal_distribution: 1000, gal_contract: 200, gal_taproom: 300, gal_wholesale: 500,
  gal_beginning_inventory: 0, gal_deduction_other: 0, gal_adjustments_part3: 0,
  gal_military_part4: 0, gal_ending_inventory: 0,
  nc_excise_rate_micros: 617100, flag_timely: 1, cents_penalty: 0, cents_interest: 0,
};

describe("deriveBeerExciseFigures", () => {
  it("waterfall: L2 all channels, L4a = wholesale, L5 = taxable channels", () => {
    const f = deriveBeerExciseFigures(base);
    expect(f.gal_produced_for_sale).toBe(2000);       // 1000+200+300+500
    expect(f.gal_total_available).toBe(2000);
    expect(f.gal_allowable_deductions).toBe(500);     // wholesale
    expect(f.gal_taxable).toBe(1500);                 // 1000+200+300
  });
  it("L6 = taxable gallons × 61.71¢, L7 = 2% when timely, L8/L11 roll up", () => {
    const f = deriveBeerExciseFigures(base);
    expect(f.cents_excise_due).toBe(Math.round(1500 * 61.71));  // 92565
    expect(f.cents_discount).toBe(Math.round(92565 * 0.02));    // 1851
    expect(f.cents_net_tax_due).toBe(92565 - 1851);
    expect(f.cents_total_payment_due).toBe(92565 - 1851);
  });
  it("no discount when not timely; penalty+interest add to L11", () => {
    const f = deriveBeerExciseFigures({ ...base, flag_timely: 0, cents_penalty: 500, cents_interest: 250 });
    expect(f.cents_discount).toBe(0);
    expect(f.cents_total_payment_due).toBe(f.cents_excise_due as number + 750);
  });
  it("extra manual deductions & inventory reduce L5; floored at 0", () => {
    const f = deriveBeerExciseFigures({ ...base, gal_deduction_other: 100, gal_ending_inventory: 50 });
    expect(f.gal_taxable).toBe(1350);
    const z = deriveBeerExciseFigures({ ...base, gal_military_part4: 99999 });
    expect(z.gal_taxable).toBe(0);
  });
  it("falls back to statutory micros when rate field absent", () => {
    const { nc_excise_rate_micros: _omit, ...noRate } = base;
    const f = deriveBeerExciseFigures(noRate);
    expect(f.cents_excise_due).toBe(Math.round(1500 * 61.71));
  });
});
