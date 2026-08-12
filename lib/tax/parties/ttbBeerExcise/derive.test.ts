/**
 * Pins the TTB F 5130.Pilot-B derivation — the one place the form's arithmetic
 * lives, shared by the server compute, the server merge and the client's live
 * edit. The cases here are the ones where getting it wrong would misstate a
 * federal tax return rather than just look odd.
 */
import { describe, it, expect } from "vitest";
import type { WorksheetFields } from "@/lib/tax/types";
import { deriveTtbFigures, increasingRowKeys, decreasingRowKeys, roundBbl } from "./derive";
import { TTB_REDUCED_RATE_MICROS_FALLBACK } from "./rates";

/** A field set shaped like `computeTtbFigures`' initial one, with overrides applied. */
function fieldsWith(overrides: Record<string, number | string | null> = {}) {
  return {
    bbl_distribution: 0,
    bbl_contract: 0,
    bbl_taproom: 0,
    bbl_wholesale: 0,
    ttb_reduced_rate_micros: TTB_REDUCED_RATE_MICROS_FALLBACK,
    bbl_exports_without_tax: 0,
    bbl_transfers_in_bond: 0,
    bbl_other_removals_without_tax: 0,
    bbl_received_in_bond: 0,
    bbl_returned_after_removal: 0,
    bbl_inventory_overage: 0,
    bbl_consumed_or_destroyed: 0,
    bbl_losses: 0,
    bbl_inventory_shortage: 0,
    cents_interest: 0,
    cents_penalties: 0,
    ...overrides,
  };
}

describe("deriveTtbFigures — taxable removals", () => {
  it("taxes every shipment channel, including wholesale", () => {
    const f = deriveTtbFigures(
      fieldsWith({ bbl_distribution: 10, bbl_contract: 20, bbl_taproom: 5, bbl_wholesale: 15 }),
    );
    // The whole point of not reusing NC's TAXABLE_CHANNELS: wholesale is a
    // federal removal. If it were excluded this would be 35.
    expect(f.bbl_total_removals).toBe(50);
    expect(f.bbl_total_taxable).toBe(50);
  });

  it("subtracts exports and transfers in bond from taxable removals", () => {
    const f = deriveTtbFigures(
      fieldsWith({ bbl_distribution: 100, bbl_exports_without_tax: 12, bbl_transfers_in_bond: 8 }),
    );
    expect(f.bbl_removals_without_tax_total).toBe(20);
    expect(f.bbl_total_taxable).toBe(80);
  });

  it("floors taxable removals at zero rather than going negative", () => {
    const f = deriveTtbFigures(fieldsWith({ bbl_distribution: 5, bbl_exports_without_tax: 40 }));
    expect(f.bbl_total_taxable).toBe(0);
    expect(f.cents_tax_reduced).toBe(0);
  });

  it("keeps fractional barrels instead of rounding to whole units", () => {
    const f = deriveTtbFigures(
      fieldsWith({ bbl_distribution: 85.42, bbl_contract: 248.63, bbl_taproom: 28.45 }),
    );
    expect(f.bbl_total_removals).toBe(362.5);
  });
});

describe("deriveTtbFigures — tax calculation (lines 8-15)", () => {
  it("puts everything on line 8 at the reduced rate and leaves 9 and 10 empty", () => {
    const f = deriveTtbFigures(fieldsWith({ bbl_distribution: 100 }));
    expect(f.bbl_rate_reduced).toBe(100);
    expect(f.cents_tax_reduced).toBe(35_000); // 100 bbl x $3.50
    expect(f.bbl_rate_16).toBe(0);
    expect(f.cents_tax_16).toBe(0);
    expect(f.bbl_rate_18).toBe(0);
    expect(f.cents_tax_18).toBe(0);
    expect(f.cents_total_tax).toBe(35_000);
  });

  it("rounds tax on a fractional barrel figure exactly once", () => {
    const f = deriveTtbFigures(fieldsWith({ bbl_taproom: 28.45 }));
    // 28.45 x $3.50 = $99.575 -> 9958 cents
    expect(f.cents_tax_reduced).toBe(9958);
  });

  it("honours a live rate from tax_rates over the statutory fallback", () => {
    const f = deriveTtbFigures(fieldsWith({ bbl_distribution: 100, ttb_reduced_rate_micros: 4_000_000 }));
    expect(f.cents_tax_reduced).toBe(40_000);
  });

  it("falls back to the statutory rate when the rate field is absent or zero", () => {
    const f = deriveTtbFigures(fieldsWith({ bbl_distribution: 100, ttb_reduced_rate_micros: 0 }));
    expect(f.cents_tax_reduced).toBe(35_000);
  });

  it("walks lines 11 -> 12 -> 13 -> 14 -> 15", () => {
    const inc = increasingRowKeys(1);
    const dec = decreasingRowKeys(1);
    const f = deriveTtbFigures(
      fieldsWith({
        bbl_distribution: 100,
        [inc.quantity]: 10,
        [inc.rateMicros]: 3_500_000,
        cents_interest: 500,
        cents_penalties: 250,
        [dec.amountCents]: 1_000,
      }),
    );
    expect(f.cents_total_tax).toBe(35_000); // L11
    expect(f.cents_increasing_tax_due).toBe(3_500); // L20
    expect(f.cents_increasing_adjustments).toBe(4_250); // L23 = 3500 + 500 + 250
    expect(f.cents_gross_due).toBe(39_250); // L13
    expect(f.cents_decreasing_adjustments).toBe(1_000); // L27
    expect(f.cents_amount_due).toBe(38_250); // L15
  });

  it("derives each Schedule A row's tax due from quantity x rate", () => {
    const keys = increasingRowKeys(2);
    const f = deriveTtbFigures(fieldsWith({ [keys.quantity]: 2.5, [keys.rateMicros]: 18_000_000 }));
    expect(f[keys.cents]).toBe(4_500); // 2.5 bbl x $18.00
  });
});

describe("deriveTtbFigures — brewery operations (lines 28-44)", () => {
  it("closes the reconciliation at zero for the plain case", () => {
    const f = deriveTtbFigures(fieldsWith({ bbl_distribution: 85.42, bbl_taproom: 28.45 }));
    expect(f.bbl_opening).toBe(0);
    expect(f.bbl_produced).toBe(113.87); // produced == removed
    expect(f.bbl_total_available).toBe(113.87);
    expect(f.bbl_taxpaid_removals_total).toBe(113.87);
    expect(f.bbl_other_subtractions).toBe(0);
    expect(f.bbl_ending).toBe(0);
  });

  it("raises production to cover an export so line 44 still closes at zero", () => {
    const f = deriveTtbFigures(fieldsWith({ bbl_distribution: 100, bbl_exports_without_tax: 20 }));
    // 80 bbl taxpaid + 20 bbl exported = 100 bbl had to be produced.
    expect(f.bbl_produced).toBe(100);
    expect(f.bbl_other_subtractions).toBe(20);
    expect(f.bbl_ending).toBe(0);
  });

  it("raises production to cover losses and destroyed beer", () => {
    const f = deriveTtbFigures(
      fieldsWith({ bbl_distribution: 100, bbl_losses: 3, bbl_consumed_or_destroyed: 2, bbl_inventory_shortage: 1 }),
    );
    expect(f.bbl_other_subtractions).toBe(6);
    expect(f.bbl_produced).toBe(106);
    expect(f.bbl_ending).toBe(0);
  });

  it("lets beer received in bond displace production rather than inflating it", () => {
    const f = deriveTtbFigures(fieldsWith({ bbl_distribution: 100, bbl_received_in_bond: 30 }));
    expect(f.bbl_produced).toBe(70);
    expect(f.bbl_total_available).toBe(100);
    expect(f.bbl_ending).toBe(0);
  });

  it("leaves a real closing balance when additions exceed removals", () => {
    // The guard case: produced can't go below zero, so the surplus shows up on
    // line 44 and has to carry into next quarter (calc.ts warns).
    const f = deriveTtbFigures(fieldsWith({ bbl_distribution: 10, bbl_received_in_bond: 50 }));
    expect(f.bbl_produced).toBe(0);
    expect(f.bbl_ending).toBe(40);
  });

  it("never files a semimonthly Pilot-A figure on line 42a", () => {
    const f = deriveTtbFigures(fieldsWith({ bbl_distribution: 10, bbl_pilot_a_removals: 99 }));
    expect(f.bbl_pilot_a_removals).toBe(0);
    expect(f.bbl_taxpaid_removals_total).toBe(10);
  });
});

describe("deriveTtbFigures — questions answered from the feed", () => {
  it("answers line 46 yes when anything shipped on the contract channel", () => {
    expect(deriveTtbFigures(fieldsWith({ bbl_contract: 0.5 })).flag_contract_removals).toBe(1);
  });

  it("answers line 46 no when nothing did", () => {
    expect(deriveTtbFigures(fieldsWith({ bbl_distribution: 100 })).flag_contract_removals).toBe(0);
  });

  it("always attests reduced-rate eligibility — this brewery produces what it removes", () => {
    expect(deriveTtbFigures(fieldsWith({ bbl_contract: 100 })).flag_reduced_rate_eligible).toBe(1);
  });
});

describe("deriveTtbFigures — mechanics", () => {
  it("passes unrecognized keys through untouched", () => {
    const f = deriveTtbFigures(fieldsWith({ signer_date: "10-14-2026", submission_version: "Original" }));
    expect(f.signer_date).toBe("10-14-2026");
    expect(f.submission_version).toBe("Original");
  });

  it("does not mutate its input", () => {
    const input: WorksheetFields = fieldsWith({ bbl_distribution: 10 });
    deriveTtbFigures(input);
    expect(input.bbl_total_removals).toBeUndefined();
  });

  it("is idempotent — re-deriving a derived field set changes nothing", () => {
    const once = deriveTtbFigures(fieldsWith({ bbl_distribution: 85.42, bbl_exports_without_tax: 5.5 }));
    expect(deriveTtbFigures(once)).toEqual(once);
  });

  it("treats null and absent fields as zero", () => {
    const f = deriveTtbFigures({ bbl_distribution: null, bbl_taproom: 10 });
    expect(f.bbl_total_removals).toBe(10);
  });
});

describe("roundBbl", () => {
  it("rounds to the 2 decimal places TTB reports", () => {
    expect(roundBbl(248.6349)).toBe(248.63);
    expect(roundBbl(248.6351)).toBe(248.64);
    expect(roundBbl(0.1 + 0.2)).toBe(0.3);
  });
});
