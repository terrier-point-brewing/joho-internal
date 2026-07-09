import type { BreakdownInput } from "./depositBreakdown";

export interface AuditRow {
  table_name: string;
  record_id: string;
  operation: string;
  changed_at: string;
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
}

export interface RecipeIngredientNow {
  recipe_ingredient_id: string;
  ingredient_id: string;
  quantity_per_bbl: number;
}

export interface IngredientNow {
  id: string;
  name: string;
  unit: string;
  cost_per_unit: number | null;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Value of `field` for a single record as of `asOf`. `rows` must already be
 * filtered to one record_id (any table). Returns the last write at/before asOf;
 * if asOf precedes all writes, the earliest old_data value; else `fallback`.
 */
export function reconstructFieldAsOf(
  rows: AuditRow[],
  field: string,
  asOf: string,
  fallback: number
): number {
  const sorted = [...rows].sort((a, b) => a.changed_at.localeCompare(b.changed_at));
  let latest: number | null = null;
  for (const r of sorted) {
    if (r.changed_at <= asOf && r.new_data && field in r.new_data) {
      const v = num(r.new_data[field]);
      if (v != null) latest = v;
    }
  }
  if (latest != null) return latest;
  const first = sorted.find((r) => r.old_data && field in r.old_data);
  const pre = first ? num(first.old_data![field]) : null;
  return pre != null ? pre : fallback;
}

/** True if this recipe_ingredient's first audit event is an INSERT after asOf. */
function insertedAfter(rows: AuditRow[], asOf: string): boolean {
  const sorted = [...rows].sort((a, b) => a.changed_at.localeCompare(b.changed_at));
  const first = sorted[0];
  return !!first && first.operation === "INSERT" && first.changed_at > asOf;
}

/**
 * Reconstruct the frozen breakdown weights for an allocation's recipe as of
 * `asOf`. Starts from the current recipe_ingredients, drops rows inserted after
 * asOf, and uses historical cost/quantity. `weight = qty × cost` (volume and
 * allocation % are common factors that cancel under buildBreakdownLines scaling).
 */
export function reconstructBreakdownAsOf(params: {
  asOf: string;
  recipeIngredientsNow: RecipeIngredientNow[];
  ingredientsNow: Map<string, IngredientNow>;
  audit: AuditRow[];
}): BreakdownInput[] {
  const { asOf, recipeIngredientsNow, ingredientsNow, audit } = params;

  const byRecord = new Map<string, AuditRow[]>();
  for (const r of audit) {
    const key = `${r.table_name}:${r.record_id}`;
    (byRecord.get(key) ?? byRecord.set(key, []).get(key)!).push(r);
  }
  const rowsFor = (table: string, id: string) => byRecord.get(`${table}:${id}`) ?? [];

  const out: BreakdownInput[] = [];
  for (const ri of recipeIngredientsNow) {
    const riRows = rowsFor("recipe_ingredients", ri.recipe_ingredient_id);
    if (insertedAfter(riRows, asOf)) continue;

    const ing = ingredientsNow.get(ri.ingredient_id);
    const ingRows = rowsFor("ingredients", ri.ingredient_id);

    const qty = reconstructFieldAsOf(riRows, "quantity_per_bbl", asOf, ri.quantity_per_bbl);
    const cost = reconstructFieldAsOf(ingRows, "cost_per_unit", asOf, ing?.cost_per_unit ?? NaN);
    if (!Number.isFinite(cost)) continue;

    out.push({
      ingredient_id: ri.ingredient_id,
      name: ing?.name ?? "Unknown ingredient",
      unit: ing?.unit ?? "",
      quantity_per_bbl: qty,
      cost_per_unit: cost,
      weight: qty * cost,
    });
  }
  return out;
}
