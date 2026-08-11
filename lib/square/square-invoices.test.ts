// lib/square/square-invoices.test.ts
//
// Tests the dollars → cents seam in calculateIngredientDeposit. cost_per_unit_usd is
// a decimal USD column; the deposit math runs in dollars and crosses to integer
// cents (deposit_cents) via dollarsToCents. We drive the pure math with a thin
// Supabase stub that returns a fixed batch + recipe_ingredients and assert the
// REAL computed deposit_cents — not that any mock was called.
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { calculateIngredientDeposit } from "./square-invoices";

interface BatchRow {
  id: string;
  beer_name: string;
  volume_bbl: number;
  turns: number | null;
  recipe_id: string | null;
}

interface RecipeIngredientRow {
  quantity_per_turn: number;
  ingredients: { id: string; name: string; unit: string; cost_per_unit_usd: number | null } | null;
}

/**
 * Stub whose brew_batches.single() resolves to `batch` and whose
 * recipe_ingredients query resolves to `ingredients`.
 */
function stub(batch: BatchRow | null, ingredients: RecipeIngredientRow[]): SupabaseClient {
  const client = {
    from(table: string) {
      if (table === "brew_batches") {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: batch, error: batch ? null : { message: "not found" } }),
            }),
          }),
        };
      }
      // recipe_ingredients
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: ingredients, error: null }),
        }),
      };
    },
  };
  return client as unknown as SupabaseClient;
}

const batch: BatchRow = { id: "b1", beer_name: "Test IPA", volume_bbl: 10, turns: 1, recipe_id: "r1" };

describe("calculateIngredientDeposit", () => {
  it("computes deposit_cents = round(sum(qty/turn × turns × cost/unit) × pct/100 × 100)", async () => {
    // 20 units/turn × 1 turn × $0.6171/unit = $12.342 total ; 100% deposit.
    // $12.342 → dollarsToCents → round(1234.2) = 1234 cents.
    const result = await calculateIngredientDeposit(
      stub(batch, [
        { quantity_per_turn: 20, ingredients: { id: "i1", name: "Malt", unit: "lb", cost_per_unit_usd: 0.6171 } },
      ]),
      "b1",
      100
    );
    expect(result.total_ingredient_cost_usd).toBeCloseTo(12.342, 6);
    expect(result.deposit_usd).toBeCloseTo(12.342, 6);
    expect(result.deposit_cents).toBe(1234);
    expect(Number.isInteger(result.deposit_cents)).toBe(true);
    expect(result.ingredient_count).toBe(1);
  });

  it("applies the percentage before crossing to cents", async () => {
    // total $12.342 × 50% = $6.171 → round(617.1) = 617 cents.
    const result = await calculateIngredientDeposit(
      stub(batch, [
        { quantity_per_turn: 20, ingredients: { id: "i1", name: "Malt", unit: "lb", cost_per_unit_usd: 0.6171 } },
      ]),
      "b1",
      50
    );
    expect(result.deposit_cents).toBe(617);
  });

  it("sums multiple ingredients then rounds once at the cents boundary", async () => {
    // (1 + 2.00) per turn × 1 turn = $3.005 total → round(300.5) = 301 cents.
    const result = await calculateIngredientDeposit(
      stub({ ...batch, volume_bbl: 1 }, [
        { quantity_per_turn: 1, ingredients: { id: "i1", name: "Hops", unit: "oz", cost_per_unit_usd: 1.005 } },
        { quantity_per_turn: 1, ingredients: { id: "i2", name: "Yeast", unit: "pkg", cost_per_unit_usd: 2.0 } },
      ]),
      "b1",
      100
    );
    expect(result.deposit_cents).toBe(301);
  });

  it("skips ingredients with a null cost_per_unit_usd", async () => {
    const result = await calculateIngredientDeposit(
      stub({ ...batch, volume_bbl: 1 }, [
        { quantity_per_turn: 1, ingredients: { id: "i1", name: "Water", unit: "gal", cost_per_unit_usd: null } },
        { quantity_per_turn: 4, ingredients: { id: "i2", name: "Malt", unit: "lb", cost_per_unit_usd: 0.25 } },
      ]),
      "b1",
      100
    );
    // only the malt counts: 4/turn × 1 turn × 0.25 = $1.00 → 100 cents.
    expect(result.deposit_cents).toBe(100);
    expect(result.ingredient_count).toBe(1);
  });

  // A partner is billed for the grain the brewer weighed out, not for the rate
  // that came back from dividing it by a below-turn yield. The displayed
  // per-bbl figure spreads the bill over the turn's own volume, so
  // rate × volume still reconciles to the line total on the invoice.
  it("prices the entered bill, and reports a per-bbl rate that ties to it", async () => {
    const result = await calculateIngredientDeposit(
      stub({ ...batch, volume_bbl: 20, turns: 1 }, [
        { quantity_per_turn: 55, ingredients: { id: "i1", name: "Debittered Black", unit: "lb", cost_per_unit_usd: 1 } },
      ]),
      "b1",
      100
    );
    expect(result.total_ingredient_cost_usd).toBeCloseTo(55, 6);
    const line = result.breakdown[0];
    expect(line.quantity_per_bbl).toBeCloseTo(2.75, 6);
    expect(line.quantity_per_bbl * 20).toBeCloseTo(55, 6);
  });

  // Two turns of the same recipe buy two bills' worth of grain.
  it("scales the bill by the turn count", async () => {
    const result = await calculateIngredientDeposit(
      stub({ ...batch, volume_bbl: 40, turns: 2 }, [
        { quantity_per_turn: 55, ingredients: { id: "i1", name: "Debittered Black", unit: "lb", cost_per_unit_usd: 1 } },
      ]),
      "b1",
      100
    );
    expect(result.total_ingredient_cost_usd).toBeCloseTo(110, 6);
    expect(result.breakdown[0].quantity_per_bbl).toBeCloseTo(2.75, 6);
  });
});
