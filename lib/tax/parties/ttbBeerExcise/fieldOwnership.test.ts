/**
 * Ownership is what decides whether a recompute overwrites a filer's entry or
 * preserves it, so the interesting assertions here are the boundaries: what the
 * shipment feed owns, what only a human can answer, and the derived operations
 * section that nobody should be able to type into.
 */
import { describe, it, expect } from "vitest";
import { isComputedField, resolveTtbFieldOwnership } from "./fieldOwnership";
import { decreasingRowKeys, increasingRowKeys } from "./derive";
import { SCHEDULE_A_ROWS, ttbPeriodLabel, ttbSerialNumber } from "./rates";

describe("resolveTtbFieldOwnership", () => {
  it("owns everything the shipment feed and the form's arithmetic produce", () => {
    for (const key of [
      "bbl_distribution",
      "bbl_contract",
      "bbl_taproom",
      "bbl_wholesale",
      "bbl_total_removals",
      "bbl_total_taxable",
      "cents_tax_reduced",
      "cents_total_tax",
      "cents_gross_due",
      "cents_amount_due",
      "serial_number",
      "flag_contract_removals",
      "flag_reduced_rate_eligible",
    ]) {
      expect(resolveTtbFieldOwnership(key), key).toBe("computed");
    }
  });

  it("leaves the whole operations section computed — there is nothing to type", () => {
    for (const key of [
      "bbl_opening",
      "bbl_produced",
      "bbl_total_available",
      "bbl_available_recon",
      "bbl_pilot_a_removals",
      "bbl_taxpaid_removals_total",
      "bbl_other_subtractions",
      "bbl_ending",
    ]) {
      expect(resolveTtbFieldOwnership(key), key).toBe("computed");
    }
  });

  it("leaves the movements the feed cannot see to the filer", () => {
    for (const key of [
      "bbl_exports_without_tax",
      "bbl_transfers_in_bond",
      "bbl_other_removals_without_tax",
      "bbl_received_in_bond",
      "bbl_returned_after_removal",
      "bbl_inventory_overage",
      "bbl_consumed_or_destroyed",
      "bbl_losses",
      "bbl_inventory_shortage",
      "cents_interest",
      "cents_penalties",
      "cents_amount_paid",
      "flag_controlled_group",
      "signer_date",
    ]) {
      expect(resolveTtbFieldOwnership(key), key).toBe("manual");
    }
  });

  it("owns each Schedule A row's tax due but not the inputs behind it", () => {
    for (let i = 1; i <= SCHEDULE_A_ROWS; i += 1) {
      const inc = increasingRowKeys(i);
      expect(resolveTtbFieldOwnership(inc.cents), inc.cents).toBe("computed");
      expect(resolveTtbFieldOwnership(inc.quantity), inc.quantity).toBe("manual");
      expect(resolveTtbFieldOwnership(inc.rateMicros), inc.rateMicros).toBe("manual");

      // A decreasing adjustment is claimed, not derived — every column is manual.
      const dec = decreasingRowKeys(i);
      for (const key of Object.values(dec)) {
        expect(resolveTtbFieldOwnership(key), key).toBe("manual");
      }
    }
  });

  it("defaults an unrecognized key to manual", () => {
    expect(resolveTtbFieldOwnership("something_new")).toBe("manual");
    expect(isComputedField("something_new")).toBe(false);
  });
});

describe("ttbSerialNumber", () => {
  it("uses the brewery's TR-year-quarter format", () => {
    expect(ttbSerialNumber("2026-01-01")).toBe("TR-2026-1");
    expect(ttbSerialNumber("2026-04-01")).toBe("TR-2026-2");
    expect(ttbSerialNumber("2026-07-01")).toBe("TR-2026-3");
    expect(ttbSerialNumber("2026-10-01")).toBe("TR-2026-4");
  });

  it("is a pure function of the period, so a recompute cannot mint a duplicate", () => {
    expect(ttbSerialNumber("2026-07-01")).toBe(ttbSerialNumber("2026-07-01"));
  });

  it("rejects an unparseable period start rather than emitting a wrong serial", () => {
    expect(() => ttbSerialNumber("not-a-date")).toThrow();
  });
});

describe("ttbPeriodLabel", () => {
  it("reads as the quarter the filer would say out loud", () => {
    expect(ttbPeriodLabel("2026-07-01")).toBe("Q3 2026");
  });
});
