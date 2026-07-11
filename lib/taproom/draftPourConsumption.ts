// Pour-consumption primitive: fl oz of draft beer poured, from Square pour-variation
// sales × pour size. Single validated aggregation path consumed by the taproom
// sell-through sync (Task 3), shrinkage projections, and reporting (Tasks 4/5/7).
import { volumeFlOzPerUnit } from "@/lib/square/catalogUnits";

export interface PourVar { id: string; oz: number | null }

// recipeId → its draft base variation's pour-size sibling variations (5oz/10oz/16oz),
// loaded from the catalog mirror (falling back to parsing oz from the variation name).
export async function loadDraftPourVariations(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from: (t: string) => any },
): Promise<Map<string, PourVar[]>> {
  const { data: links, error } = await supabase
    .from("recipe_square_links")
    .select("recipe_id, square_item_id")
    .eq("packaging", "draft");
  if (error) throw new Error(error.message);
  const itemToRecipe = new Map<string, string>();
  for (const l of (links ?? []) as { recipe_id: string; square_item_id: string | null }[]) {
    if (l.square_item_id) itemToRecipe.set(l.square_item_id, l.recipe_id);
  }
  const itemIds = [...itemToRecipe.keys()];
  const byRecipe = new Map<string, PourVar[]>();
  if (itemIds.length === 0) return byRecipe;

  const { data: sibs, error: sibErr } = await supabase
    .from("square_catalog_variations")
    .select("square_variation_id, square_item_id, variation_name, volume_fl_oz_per_unit")
    .in("square_item_id", itemIds);
  if (sibErr) throw new Error(sibErr.message);
  for (const v of (sibs ?? []) as { square_variation_id: string; square_item_id: string; variation_name: string | null; volume_fl_oz_per_unit: number | null }[]) {
    const recipeId = itemToRecipe.get(v.square_item_id);
    if (!recipeId) continue;
    const oz = v.volume_fl_oz_per_unit ?? volumeFlOzPerUnit(v.variation_name);
    const list = byRecipe.get(recipeId) ?? [];
    list.push({ id: v.square_variation_id, oz });
    byRecipe.set(recipeId, list);
  }
  return byRecipe;
}

// Pure: "<varId>\t<YYYY-MM-DD>" → units  ⇒  per (recipe, day) fl oz + pour units.
export function aggregatePourFlOzByRecipeDay(
  salesByDay: Map<string, number>,
  pourVarsByRecipe: Map<string, PourVar[]>,
): { recipe_id: string; business_date: string; fl_oz: number; pour_units: number }[] {
  const ozByVar = new Map<string, number | null>();
  const recipeByVar = new Map<string, string>();
  for (const [recipeId, vars] of pourVarsByRecipe) {
    for (const v of vars) { ozByVar.set(v.id, v.oz); recipeByVar.set(v.id, recipeId); }
  }
  const acc = new Map<string, { recipe_id: string; business_date: string; fl_oz: number; pour_units: number }>();
  for (const [key, units] of salesByDay) {
    const [varId, day] = key.split("\t");
    const recipeId = recipeByVar.get(varId);
    if (!recipeId) continue;
    const oz = ozByVar.get(varId);
    const k = `${recipeId}\t${day}`;
    const row = acc.get(k) ?? { recipe_id: recipeId, business_date: day, fl_oz: 0, pour_units: 0 };
    row.pour_units += units;
    if (oz) row.fl_oz += units * oz;
    acc.set(k, row);
  }
  return [...acc.values()];
}

// Pure: varId → total units  ⇒  recipeId → { flOz, units }.
export function aggregatePourFlOzByRecipe(
  salesTotals: Map<string, number>,
  pourVarsByRecipe: Map<string, PourVar[]>,
): Map<string, { flOz: number; units: number }> {
  const out = new Map<string, { flOz: number; units: number }>();
  for (const [recipeId, vars] of pourVarsByRecipe) {
    let flOz = 0, units = 0;
    for (const v of vars) {
      const sold = salesTotals.get(v.id) ?? 0;
      units += sold;
      if (v.oz) flOz += sold * v.oz;
    }
    out.set(recipeId, { flOz, units });
  }
  return out;
}

// Ledger read: recipeId → average daily pour fl oz + units over the trailing window.
export async function fetchDailyPourSellThrough(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from: (t: string) => any },
  windowDays: number,
): Promise<Map<string, { dailyFlOz: number; dailyUnits: number }>> {
  const startDate = new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("draft_pour_consumption")
    .select("recipe_id, fl_oz, pour_units")
    .gte("business_date", startDate);
  if (error) throw new Error(error.message);
  const sum = new Map<string, { flOz: number; units: number }>();
  for (const r of (data ?? []) as { recipe_id: string; fl_oz: number; pour_units: number }[]) {
    const e = sum.get(r.recipe_id) ?? { flOz: 0, units: 0 };
    e.flOz += Number(r.fl_oz); e.units += Number(r.pour_units);
    sum.set(r.recipe_id, e);
  }
  const out = new Map<string, { dailyFlOz: number; dailyUnits: number }>();
  for (const [recipeId, e] of sum) out.set(recipeId, { dailyFlOz: e.flOz / windowDays, dailyUnits: e.units / windowDays });
  return out;
}
