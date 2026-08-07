// lib/production/depositReconstruction.ts
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
  cost_per_unit_usd: number | null;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  return typeof v === "string" ? v : String(v);
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

/**
 * State of one recipe_ingredient record at asOf, or null if it did not exist
 * then (inserted later, or already deleted). Uses the last audit event whose
 * changed_at <= asOf. If there is no such event but the earliest recorded event
 * is not an INSERT, the row already existed before the audit trail began for it
 * (asOf predates its first recorded change) and its prior state is recovered
 * from that event's old_data.
 */
function recipeIngredientStateAsOf(
  rows: AuditRow[],
  asOf: string
): { ingredient_id: string; quantity_per_bbl: number } | null {
  const sorted = [...rows].sort((a, b) => a.changed_at.localeCompare(b.changed_at));
  let last: AuditRow | null = null;
  for (const r of sorted) {
    if (r.changed_at <= asOf) last = r;
  }

  let data: Record<string, unknown> | null;
  if (last) {
    if (last.operation === "DELETE") return null;
    data = last.new_data ?? last.old_data;
  } else {
    const earliest = sorted[0];
    if (!earliest || earliest.operation === "INSERT") return null;
    data = earliest.old_data;
  }

  if (!data) return null;
  const ingredient_id = str(data["ingredient_id"]);
  const quantity_per_bbl = num(data["quantity_per_bbl"]);
  if (ingredient_id == null || quantity_per_bbl == null) return null;
  return { ingredient_id, quantity_per_bbl };
}

function groupByRecord(rows: AuditRow[]): Map<string, AuditRow[]> {
  const m = new Map<string, AuditRow[]>();
  for (const r of rows) {
    const arr = m.get(r.record_id) ?? [];
    arr.push(r);
    m.set(r.record_id, arr);
  }
  return m;
}

/**
 * Reconstruct the frozen breakdown weights for an allocation's recipe as of
 * `asOf`, driven by the recipe_ingredients audit trail so that recipe edits
 * (full delete + re-insert) and membership changes are handled correctly:
 *   - a recipe_ingredient inserted after asOf is excluded,
 *   - one deleted after asOf is included with its historical quantity,
 *   - a recipe_ingredient with no audit history at all falls back to its
 *     current row (pre-audit / unaudited rows).
 * `weight = qty × cost` (batch volume and allocation % are common factors that
 * cancel under buildBreakdownLines scaling, so they are not reconstructed).
 */
export function reconstructBreakdownAsOf(params: {
  asOf: string;
  currentRecipeIngredients: RecipeIngredientNow[];
  ingredientsNow: Map<string, IngredientNow>;
  recipeIngredientAudit: AuditRow[];
  ingredientAudit: AuditRow[];
}): BreakdownInput[] {
  const { asOf, currentRecipeIngredients, ingredientsNow, recipeIngredientAudit, ingredientAudit } = params;

  const riByRecord = groupByRecord(recipeIngredientAudit);
  const ingByRecord = groupByRecord(ingredientAudit);
  const currentById = new Map(currentRecipeIngredients.map((ri) => [ri.recipe_ingredient_id, ri]));

  // Candidate recipe_ingredient records: everything seen in audit, plus current
  // rows (covers rows created before the audit system existed / unaudited rows).
  const recordIds = new Set<string>([...riByRecord.keys(), ...currentById.keys()]);

  const out: BreakdownInput[] = [];
  for (const recordId of recordIds) {
    const riRows = riByRecord.get(recordId) ?? [];
    let state: { ingredient_id: string; quantity_per_bbl: number } | null;
    if (riRows.length > 0) {
      state = recipeIngredientStateAsOf(riRows, asOf);
    } else {
      const cur = currentById.get(recordId);
      state = cur ? { ingredient_id: cur.ingredient_id, quantity_per_bbl: cur.quantity_per_bbl } : null;
    }
    if (!state) continue;

    const ing = ingredientsNow.get(state.ingredient_id);
    const ingRows = ingByRecord.get(state.ingredient_id) ?? [];
    const cost = reconstructFieldAsOf(ingRows, "cost_per_unit_usd", asOf, ing?.cost_per_unit_usd ?? NaN);
    if (!Number.isFinite(cost)) continue;

    let name = ing?.name ?? null;
    let unit = ing?.unit ?? null;
    if (name == null || unit == null) {
      const anyRow = [...ingRows].sort((a, b) => a.changed_at.localeCompare(b.changed_at)).pop();
      const d = anyRow?.new_data ?? anyRow?.old_data ?? null;
      name = name ?? (d ? str(d["name"]) : null) ?? "Unknown ingredient";
      unit = unit ?? (d ? str(d["unit"]) : null) ?? "";
    }

    out.push({
      ingredient_id: state.ingredient_id,
      name,
      unit,
      quantity_per_bbl: state.quantity_per_bbl,
      cost_per_unit_usd: cost,
      weight: state.quantity_per_bbl * cost,
    });
  }
  return out;
}
