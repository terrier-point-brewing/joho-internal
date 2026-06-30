// lib/production/exciseTax.test.ts
//
// Characterization tests for computeExciseTaxBreakdown. The function is async and
// reads excise_tax_rates from Supabase, but the load-bearing logic is the pure
// per-rate math: unit selection (bbl vs gallon = bbl × GALLONS_PER_BBL) and the
// round-to-cents on the amount. We drive it with a thin stub that returns fixed
// rate rows and assert the REAL computed ExciseTaxLine values — not that any
// mock was called. Boundaries covered: zero volume, gallon conversion, cent
// rounding (round-half behavior), negative volume, empty/missing rate sets.
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeExciseTaxBreakdown } from "./exciseTax";
import { GALLONS_PER_BBL } from "@/lib/constants/production";

interface RateRow {
  id: string | null;
  name: string;
  unit: string;
  rate_usd: number;
}

/** Stub whose excise_tax_rates select resolves to `rates`. */
function stub(rates: RateRow[] | null): SupabaseClient {
  const builder = {
    select: () => builder,
    eq: () => Promise.resolve({ data: rates, error: null }),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

describe("computeExciseTaxBreakdown", () => {
  it("applies a per-bbl rate directly to the bbl volume", async () => {
    const lines = await computeExciseTaxBreakdown(stub([
      { id: "fed", name: "Federal", unit: "bbl", rate_usd: 3.5 },
    ]), 10);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      rateId: "fed", name: "Federal", unit: "bbl", rateUsd: 3.5, amountUsd: 35,
    });
  });

  it("converts bbl → gallons for a per-gallon rate using GALLONS_PER_BBL", async () => {
    // 2 bbl × 31 gal/bbl = 62 gal × $0.6175/gal = $38.285 → rounds to 38.29
    const lines = await computeExciseTaxBreakdown(stub([
      { id: "nc", name: "NC Excise", unit: "gallon", rate_usd: 0.6175 },
    ]), 2);
    expect(GALLONS_PER_BBL).toBe(31);
    expect(lines[0].unit).toBe("gallon");
    expect(lines[0].amountUsd).toBe(38.29);
  });

  it("rounds the amount to cents (round-half-up via Math.round)", async () => {
    // rate 0.005 × 1 bbl = 0.005 → ×100 = 0.5 → Math.round(0.5)=1 → /100 = 0.01
    const lines = await computeExciseTaxBreakdown(stub([
      { id: "r", name: "Tiny", unit: "bbl", rate_usd: 0.005 },
    ]), 1);
    expect(lines[0].amountUsd).toBe(0.01);
  });

  it("returns zero amounts at zero volume but still lists every active rate", async () => {
    const lines = await computeExciseTaxBreakdown(stub([
      { id: "fed", name: "Federal", unit: "bbl", rate_usd: 3.5 },
      { id: "nc", name: "NC", unit: "gallon", rate_usd: 0.6175 },
    ]), 0);
    expect(lines.map((l) => l.amountUsd)).toEqual([0, 0]);
    expect(lines.map((l) => l.name)).toEqual(["Federal", "NC"]);
  });

  it("produces a negative amount for a negative volume (no clamping)", async () => {
    const lines = await computeExciseTaxBreakdown(stub([
      { id: "fed", name: "Federal", unit: "bbl", rate_usd: 3.5 },
    ]), -4);
    expect(lines[0].amountUsd).toBe(-14);
  });

  it("returns one line per active rate, preserving order", async () => {
    const lines = await computeExciseTaxBreakdown(stub([
      { id: "a", name: "A", unit: "bbl", rate_usd: 1 },
      { id: "b", name: "B", unit: "gallon", rate_usd: 1 },
    ]), 1);
    expect(lines.map((l) => l.name)).toEqual(["A", "B"]);
    // per-bbl: 1×1=1 ; per-gallon: 1×31=31
    expect(lines.map((l) => l.amountUsd)).toEqual([1, 31]);
  });

  it("returns an empty array when there are no active rates", async () => {
    expect(await computeExciseTaxBreakdown(stub([]), 100)).toEqual([]);
  });

  it("treats a null rates result (no rows / error) as empty", async () => {
    expect(await computeExciseTaxBreakdown(stub(null), 100)).toEqual([]);
  });

  it("passes through a null rateId and unrecognized unit string as-is", async () => {
    // unit !== 'bbl' falls into the gallon branch (× GALLONS_PER_BBL).
    const lines = await computeExciseTaxBreakdown(stub([
      { id: null, name: "Mystery", unit: "barrel", rate_usd: 2 },
    ]), 1);
    expect(lines[0].rateId).toBeNull();
    expect(lines[0].unit).toBe("barrel");
    expect(lines[0].amountUsd).toBe(62); // 1 bbl × 31 × 2
  });
});
