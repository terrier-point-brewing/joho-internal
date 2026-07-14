// lib/production/exciseTax.test.ts
//
// Characterization tests for computeExciseTaxBreakdown. The function is async and
// reads active category='excise' rows from the canonical tax_rates table (via
// listTaxRates), but the load-bearing logic is the pure per-rate math: unit
// selection (bbl vs gallon = bbl × GALLONS_PER_BBL, driven by `basis`) and the
// round-to-cents on the amount. We drive it with a thin stub that returns fixed
// tax_rates rows and assert the REAL computed ExciseTaxLine values — not that
// any mock was called. This would fail if someone reverted to reading
// `rate_usd`/`unit` off the old excise_tax_rates shape instead of `rate`/`basis`
// off `tax_rates`. Boundaries covered: zero volume, gallon conversion, cent
// rounding (round-half behavior), negative volume, empty rate set, real NC/Fed
// rates.
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeExciseTaxBreakdown } from "./exciseTax";
import { GALLONS_PER_BBL } from "@/lib/constants/production";

interface RateRow {
  id: string;
  key: string;
  name: string;
  category: string;
  party_key: string | null;
  basis: "per_bbl" | "per_gallon" | "percent";
  rate: number;
  is_active: boolean;
}

/**
 * Stub whose `tax_rates` select resolves to `rates`. Mirrors the chain
 * `sb.from("tax_rates").select(...).eq("category", ...).eq("is_active", true)`
 * that `listTaxRates` builds — the query result itself must be awaitable
 * after any number of chained `.eq()` calls, so we make `result` a real
 * Promise and hang `select`/`eq` off it (each returning `result` itself).
 */
function stub(rates: RateRow[]): SupabaseClient {
  const result = Promise.resolve({ data: rates, error: null }) as unknown as {
    select: () => typeof result;
    eq: () => typeof result;
  };
  result.select = () => result;
  result.eq = () => result;
  return { from: () => result } as unknown as SupabaseClient;
}

const FEDERAL: RateRow = {
  id: "fed", key: "federal_beer_excise", name: "Federal Beer Excise Tax",
  category: "excise", party_key: "federal_ttb", basis: "per_bbl", rate: 3.5, is_active: true,
};

const NC: RateRow = {
  id: "nc", key: "nc_dor_beer_excise", name: "NC Beer Excise Tax",
  category: "excise", party_key: "nc_dor", basis: "per_gallon", rate: 0.6171, is_active: true,
};

describe("computeExciseTaxBreakdown", () => {
  it("applies a per-bbl rate directly to the bbl volume", async () => {
    const lines = await computeExciseTaxBreakdown(stub([FEDERAL]), 10);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      rateId: "fed", name: "Federal Beer Excise Tax", unit: "bbl", rateUsd: 3.5, amountUsd: 35,
    });
  });

  it("converts bbl → gallons for a per-gallon rate using GALLONS_PER_BBL, cent-snapped", async () => {
    // 2 bbl × 31 gal/bbl = 62 gal × $0.6171/gal = $38.2602 → rounds to 38.26
    const lines = await computeExciseTaxBreakdown(stub([NC]), 2);
    expect(GALLONS_PER_BBL).toBe(31);
    expect(lines[0].unit).toBe("gallon");
    expect(lines[0].amountUsd).toBe(38.26);
  });

  it("produces the real Federal + NC excise figures together for a sample volume", async () => {
    // 10 bbl: Federal 3.50 × 10 = 35.00; NC 0.6171/gal × 310 gal = 191.301 → 191.30
    const lines = await computeExciseTaxBreakdown(stub([FEDERAL, NC]), 10);
    expect(lines).toEqual([
      { rateId: "fed", name: "Federal Beer Excise Tax", unit: "bbl", rateUsd: 3.5, amountUsd: 35 },
      { rateId: "nc", name: "NC Beer Excise Tax", unit: "gallon", rateUsd: 0.6171, amountUsd: 191.3 },
    ]);
  });

  it("rounds the amount to cents (round-half-up via Math.round)", async () => {
    // rate 0.005 × 1 bbl = 0.005 → ×100 = 0.5 → Math.round(0.5)=1 → /100 = 0.01
    const lines = await computeExciseTaxBreakdown(
      stub([{ ...FEDERAL, id: "r", name: "Tiny", basis: "per_bbl", rate: 0.005 }]),
      1
    );
    expect(lines[0].amountUsd).toBe(0.01);
  });

  it("returns zero amounts at zero volume but still lists every active rate", async () => {
    const lines = await computeExciseTaxBreakdown(stub([FEDERAL, NC]), 0);
    expect(lines.map((l) => l.amountUsd)).toEqual([0, 0]);
    expect(lines.map((l) => l.name)).toEqual(["Federal Beer Excise Tax", "NC Beer Excise Tax"]);
  });

  it("produces a negative amount for a negative volume (no clamping)", async () => {
    const lines = await computeExciseTaxBreakdown(stub([FEDERAL]), -4);
    expect(lines[0].amountUsd).toBe(-14);
  });

  it("returns one line per active rate, preserving order", async () => {
    const lines = await computeExciseTaxBreakdown(
      stub([
        { ...FEDERAL, id: "a", name: "A", basis: "per_bbl", rate: 1 },
        { ...NC, id: "b", name: "B", basis: "per_gallon", rate: 1 },
      ]),
      1
    );
    expect(lines.map((l) => l.name)).toEqual(["A", "B"]);
    // per-bbl: 1×1=1 ; per-gallon: 1×31=31
    expect(lines.map((l) => l.amountUsd)).toEqual([1, 31]);
  });

  it("returns an empty array when there are no active rates", async () => {
    expect(await computeExciseTaxBreakdown(stub([]), 100)).toEqual([]);
  });

  it("passes through the row id as rateId unchanged", async () => {
    const lines = await computeExciseTaxBreakdown(
      stub([{ ...FEDERAL, id: "some-uuid-1234" }]),
      1
    );
    expect(lines[0].rateId).toBe("some-uuid-1234");
  });
});
