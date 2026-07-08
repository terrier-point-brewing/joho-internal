// Shared logic for brew_activities — the unified step/activity table scoped by
// exactly one of library_template_id / recipe_id / batch_id. Keeps the raw-step
// coercion and the recipe->batch seed transform in one testable place (replaces
// the parseStep helper that was duplicated across the old per-scope routes).

export interface ActivityStepInput {
  activity: string;
  time_label?: string | null;
  temp?: string | number | null;
  temp_unit?: string;
  amount?: string | number | null;
  amount_unit?: string | null;
  vsp?: string | number | null;
}

export interface ActivityPayload {
  sort_order: number;
  activity: string;
  time_label: string | null;
  temp: number | null;
  temp_unit: string;
  amount: number | null;
  amount_unit: string | null;
  vsp: number | null;
}

/**
 * Normalize a raw step (form/template input) into the shared brew_activities
 * payload. Blank strings and nullish values collapse to null; temp_unit defaults
 * to "F". The caller adds the scope FK (library_template_id / recipe_id / batch_id).
 */
export function parseActivityStep(s: ActivityStepInput, i: number): ActivityPayload {
  return {
    sort_order:  i,
    activity:    s.activity,
    time_label:  s.time_label || null,
    temp:        s.temp   != null && s.temp   !== "" ? Number(s.temp)   : null,
    temp_unit:   s.temp_unit || "F",
    amount:      s.amount != null && s.amount !== "" ? Number(s.amount) : null,
    amount_unit: s.amount_unit || null,
    vsp:         s.vsp    != null && s.vsp    !== "" ? Number(s.vsp)    : null,
  };
}

export interface RecipeActivityRow {
  sort_order: number;
  activity: string;
  time_label: string | null;
  temp: number | null;
  temp_unit?: string | null;
  amount: number | null;
  amount_unit?: string | null;
  vsp?: number | null;
}

/**
 * Build the brew_activities rows that seed a new batch from its recipe's default
 * activities (recipe_id-scoped rows copied into batch_id-scoped rows). Field-for-
 * field copy with temp_unit defaulting to "F"; no lineage pointer is carried.
 */
export function seedBatchActivities(templates: RecipeActivityRow[], batchId: string) {
  return templates.map((t) => ({
    batch_id:    batchId,
    sort_order:  t.sort_order,
    activity:    t.activity,
    time_label:  t.time_label,
    temp:        t.temp,
    temp_unit:   t.temp_unit ?? "F",
    amount:      t.amount,
    amount_unit: t.amount_unit ?? null,
    vsp:         t.vsp ?? null,
  }));
}
