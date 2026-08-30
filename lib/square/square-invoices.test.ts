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

/** A converted-from recipe's bill, as the exclusion path reads it (per bbl). */
interface BaseIngredientRow {
  recipe_id: string;
  ingredient_id: string;
  quantity_per_bbl: number;
}

/**
 * Stub whose brew_batches.single() resolves to `batch` and whose
 * recipe_ingredients query resolves to `ingredients`.
 *
 * The exclusion path hits the same table with `.in(...)` instead of `.eq(...)`,
 * so the two shapes are told apart by which terminator the caller reaches for.
 */
function stub(
  batch: BatchRow | null,
  ingredients: RecipeIngredientRow[],
  baseIngredients: BaseIngredientRow[] = [],
): SupabaseClient {
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
          in: (_col: string, recipeIds: string[]) =>
            Promise.resolve({
              data: baseIngredients.filter((r) => recipeIds.includes(r.recipe_id)),
              error: null,
            }),
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

/**
 * The chain the brewhouse actually runs: Pace Yourself Pilsner becomes Carolina
 * Mule (+ ginger), and Carolina Mule becomes Transfusion Pilsner (+ grape
 * juice). Transfusion's bill is COMPLETE — it carries all three — because
 * brewing it from scratch is legitimate.
 *
 * 10 bbl, 1 turn, so quantity_per_turn and quantity_per_bbl are 10× apart.
 */
const CONVERTED_BATCH: BatchRow = { id: "b2", beer_name: "Transfusion Pilsner", volume_bbl: 10, turns: 1, recipe_id: "r-transfusion" };

// $1/unit throughout, so every figure below reads straight off the quantities.
const TRANSFUSION_BILL: RecipeIngredientRow[] = [
  { quantity_per_turn: 1000, ingredients: { id: "malt",  name: "Pilsner Malt", unit: "lb", cost_per_unit_usd: 1 } },
  { quantity_per_turn: 60,   ingredients: { id: "ginger", name: "Ginger",      unit: "lb", cost_per_unit_usd: 1 } },
  { quantity_per_turn: 40,   ingredients: { id: "grape",  name: "Grape Juice", unit: "gal", cost_per_unit_usd: 1 } },
];

const ANCESTOR_BILLS: BaseIngredientRow[] = [
  // Pace Yourself Pilsner: the malt alone.
  { recipe_id: "r-pilsner", ingredient_id: "malt", quantity_per_bbl: 100 },
  // Carolina Mule: the malt AND the ginger — bills nest all the way down.
  { recipe_id: "r-mule", ingredient_id: "malt",   quantity_per_bbl: 100 },
  { recipe_id: "r-mule", ingredient_id: "ginger", quantity_per_bbl: 6 },
];

describe("calculateIngredientDeposit — converted-from exclusions", () => {
  it("charges the whole bill when nothing is excluded", async () => {
    const result = await calculateIngredientDeposit(stub(CONVERTED_BATCH, TRANSFUSION_BILL, ANCESTOR_BILLS), "b2", 100);
    expect(result.total_ingredient_cost_usd).toBe(1100);
    expect(result.excluded_recipe_ids).toEqual([]);
  });

  it("excluding the far base leaves everything the conversions added", async () => {
    // Drawn off a Pilsner batch: the malt was bought and charged there, the
    // ginger and the grape juice were not. $60 + $40.
    const result = await calculateIngredientDeposit(
      stub(CONVERTED_BATCH, TRANSFUSION_BILL, ANCESTOR_BILLS), "b2", 100,
      { excludeRecipeIds: ["r-pilsner"] },
    );
    expect(result.total_ingredient_cost_usd).toBe(100);
    expect(result.breakdown.map((b) => b.name)).toEqual(["Ginger", "Grape Juice"]);
  });

  it("excluding the near base leaves only this conversion's own addition", async () => {
    // Drawn off a Mule batch, which had already paid for the malt and the
    // ginger. Only the grape juice is new: $40.
    const result = await calculateIngredientDeposit(
      stub(CONVERTED_BATCH, TRANSFUSION_BILL, ANCESTOR_BILLS), "b2", 100,
      { excludeRecipeIds: ["r-mule"] },
    );
    expect(result.total_ingredient_cost_usd).toBe(40);
    expect(result.breakdown.map((b) => b.name)).toEqual(["Grape Juice"]);
  });

  it("takes the union, so excluding both bases matches excluding the nearer one alone", async () => {
    // The user's phrasing is "exclude Pilsner, or exclude both Pilsner and
    // Carolina Mule" — and since the Mule's bill contains the Pilsner's, the
    // pair must not subtract the malt twice and drive the line negative.
    const both = await calculateIngredientDeposit(
      stub(CONVERTED_BATCH, TRANSFUSION_BILL, ANCESTOR_BILLS), "b2", 100,
      { excludeRecipeIds: ["r-pilsner", "r-mule"] },
    );
    expect(both.total_ingredient_cost_usd).toBe(40);
    expect(both.excluded_recipe_ids).toEqual(["r-pilsner", "r-mule"]);
  });

  it("floors at zero — a base that uses MORE of something never becomes a credit", async () => {
    // A conversion can add to a batch but it cannot take malt back out, so a
    // base with a heavier grain bill contributes nothing rather than a refund.
    const result = await calculateIngredientDeposit(
      stub(CONVERTED_BATCH, TRANSFUSION_BILL, [
        { recipe_id: "r-heavy", ingredient_id: "malt", quantity_per_bbl: 400 },
      ]), "b2", 100,
      { excludeRecipeIds: ["r-heavy"] },
    );
    expect(result.total_ingredient_cost_usd).toBe(100); // ginger + grape juice, malt at 0
  });

  it("applies a percentage to the netted bill, not the full one", async () => {
    // 25% of the $40 addition, not 25% of $1,100.
    const result = await calculateIngredientDeposit(
      stub(CONVERTED_BATCH, TRANSFUSION_BILL, ANCESTOR_BILLS), "b2", 25,
      { excludeRecipeIds: ["r-mule"] },
    );
    expect(result.deposit_cents).toBe(1000);
  });

  it("ignores an exclusion naming the batch's own recipe", async () => {
    // Otherwise a self-exclusion zeroes the deposit and the invoice quietly
    // charges nothing at all.
    const result = await calculateIngredientDeposit(
      stub(CONVERTED_BATCH, TRANSFUSION_BILL, ANCESTOR_BILLS), "b2", 100,
      { excludeRecipeIds: ["r-transfusion"] },
    );
    expect(result.total_ingredient_cost_usd).toBe(1100);
    expect(result.excluded_recipe_ids).toEqual([]);
  });

  it("refuses to net anything out of a batch with no recorded volume", async () => {
    // Per-bbl rates and a per-turn bill only reconcile through the turn's
    // volume. Without one the subtraction is undefined, and charging the full
    // bill under a "conversion additions only" label is the worst outcome.
    await expect(
      calculateIngredientDeposit(
        stub({ ...CONVERTED_BATCH, volume_bbl: 0 }, TRANSFUSION_BILL, ANCESTOR_BILLS), "b2", 100,
        { excludeRecipeIds: ["r-mule"] },
      ),
    ).rejects.toThrow(/no recorded volume/);
  });
});
