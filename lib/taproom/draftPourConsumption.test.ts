import { describe, it, expect } from "vitest";
import {
  aggregatePourFlOzByRecipeDay,
  aggregatePourFlOzByRecipe,
  loadDraftPourVariations,
  fetchDailyPourSellThrough,
  type PourVar,
} from "./draftPourConsumption";

const pourVars = new Map([
  ["r1", [{ id: "v5", oz: 5 }, { id: "v16", oz: 16 }]],
]);

describe("aggregatePourFlOzByRecipeDay", () => {
  it("sums pour units × size into per-recipe-day fl oz", () => {
    const salesByDay = new Map([
      ["v5\t2026-07-01", 3],   // 15 fl oz
      ["v16\t2026-07-01", 2],  // 32 fl oz
      ["v16\t2026-07-02", 1],  // 16 fl oz
    ]);
    const rows = aggregatePourFlOzByRecipeDay(salesByDay, pourVars).sort((a, b) => a.business_date.localeCompare(b.business_date));
    expect(rows).toEqual([
      { recipe_id: "r1", business_date: "2026-07-01", fl_oz: 47, pour_units: 5 },
      { recipe_id: "r1", business_date: "2026-07-02", fl_oz: 16, pour_units: 1 },
    ]);
  });
  it("ignores sales for variations with no known size", () => {
    const rows = aggregatePourFlOzByRecipeDay(new Map([["vX\t2026-07-01", 9]]), new Map([["r1", [{ id: "vX", oz: null }]]]));
    expect(rows).toEqual([{ recipe_id: "r1", business_date: "2026-07-01", fl_oz: 0, pour_units: 9 }]);
  });
});

describe("aggregatePourFlOzByRecipe", () => {
  it("sums total pour fl oz + units per recipe", () => {
    const totals = new Map([["v5", 4], ["v16", 3]]); // 20 + 48 = 68 fl oz, 7 units
    expect(aggregatePourFlOzByRecipe(totals, pourVars).get("r1")).toEqual({ flOz: 68, units: 7 });
  });
});

// Fake supabase covering the two query shapes loadDraftPourVariations issues:
// recipe_square_links select→eq (packaging="draft"), and
// square_catalog_variations select→in (square_item_id).
function fakeLoaderSupabase(
  links: { recipe_id: string; square_item_id: string | null }[],
  sibs: { square_variation_id: string; square_item_id: string; variation_name: string | null; volume_fl_oz_per_unit: number | null }[],
) {
  return {
    from(table: string) {
      if (table === "recipe_square_links") {
        return { select: () => ({ eq: async () => ({ data: links, error: null }) }) };
      }
      if (table === "square_catalog_variations") {
        return { select: () => ({ in: async () => ({ data: sibs, error: null }) }) };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as never;
}

describe("loadDraftPourVariations", () => {
  it("groups sibling pour variations by recipe, using the stored fl-oz-per-unit", () => {
    const supabase = fakeLoaderSupabase(
      [{ recipe_id: "r1", square_item_id: "item-1" }],
      [
        { square_variation_id: "v5", square_item_id: "item-1", variation_name: "5oz Pour", volume_fl_oz_per_unit: 5 },
        { square_variation_id: "v16", square_item_id: "item-1", variation_name: "16oz Pour", volume_fl_oz_per_unit: 16 },
      ],
    );
    return loadDraftPourVariations(supabase).then((byRecipe) => {
      expect(byRecipe.get("r1")).toEqual([
        { id: "v5", oz: 5 },
        { id: "v16", oz: 16 },
      ]);
    });
  });

  it("falls back to parsing oz from the variation name when volume_fl_oz_per_unit is null", async () => {
    const supabase = fakeLoaderSupabase(
      [{ recipe_id: "r1", square_item_id: "item-1" }],
      [{ square_variation_id: "v10", square_item_id: "item-1", variation_name: "10oz Pour", volume_fl_oz_per_unit: null }],
    );
    const byRecipe = await loadDraftPourVariations(supabase);
    expect(byRecipe.get("r1")).toEqual([{ id: "v10", oz: 10 }]);
  });

  it("skips links with no square_item_id and returns an empty map without querying siblings", async () => {
    const supabase = fakeLoaderSupabase([{ recipe_id: "r1", square_item_id: null }], []);
    const byRecipe = await loadDraftPourVariations(supabase);
    expect(byRecipe.size).toBe(0);
  });

  it("ignores sibling rows whose item id has no matching recipe link", async () => {
    const supabase = fakeLoaderSupabase(
      [{ recipe_id: "r1", square_item_id: "item-1" }],
      [{ square_variation_id: "v-orphan", square_item_id: "item-2", variation_name: "5oz Pour", volume_fl_oz_per_unit: 5 }],
    );
    const byRecipe = await loadDraftPourVariations(supabase);
    expect(byRecipe.has("r1")).toBe(false);
  });
});

// Fake supabase for the draft_pour_consumption ledger read: select→gte.
function fakeLedgerSupabase(rows: { recipe_id: string; fl_oz: number; pour_units: number }[]) {
  return {
    from(table: string) {
      if (table !== "draft_pour_consumption") throw new Error(`unexpected table: ${table}`);
      return { select: () => ({ gte: async () => ({ data: rows, error: null }) }) };
    },
  } as never;
}

describe("fetchDailyPourSellThrough", () => {
  it("sums the ledger window per recipe and divides by windowDays", async () => {
    const supabase = fakeLedgerSupabase([
      { recipe_id: "r1", fl_oz: 100, pour_units: 10 },
      { recipe_id: "r1", fl_oz: 40, pour_units: 4 },
      { recipe_id: "r2", fl_oz: 70, pour_units: 7 },
    ]);
    const out = await fetchDailyPourSellThrough(supabase, 7);
    expect(out.get("r1")).toEqual({ dailyFlOz: 20, dailyUnits: 2 });
    expect(out.get("r2")).toEqual({ dailyFlOz: 10, dailyUnits: 1 });
  });

  it("returns an empty map when the ledger has no rows in the window", async () => {
    const out = await fetchDailyPourSellThrough(fakeLedgerSupabase([]), 7);
    expect(out.size).toBe(0);
  });
});

// Type-check-only sanity: PourVar shape is exported and usable by callers.
const _typeCheck: PourVar = { id: "v1", oz: null };
void _typeCheck;
