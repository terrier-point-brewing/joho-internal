import { SupabaseClient } from "@supabase/supabase-js";
import { reconstructRemainingFlOz } from "./taproomConsumptionSync";

// Rows written before the ledger-reconstruction fix stored the last full-keg
// physical count as `remaining_fl_oz` (pours, booked as ADJUSTMENT changes, were
// never subtracted) — so shrinkage read near-100% and roughly constant. This
// one-off recomputes each stored row's remaining fl oz from Square's inventory
// ledger via the same helper the live capture now uses, leaving `full_fl_oz`
// (the recount target, already correct) untouched. Dry-run unless `apply`.

const EPS = 1e-4;

export type ShrinkageBackfillStatus =
  | "updated"
  | "would_update"
  | "unchanged"
  | "skipped_no_sku"
  | "skipped_no_baseline"
  | "error";

export interface ShrinkageBackfillRowResult {
  source_ref: string;
  recipe_id: string;
  occurred_at: string;
  status: ShrinkageBackfillStatus;
  old_remaining_fl_oz: number;
  new_remaining_fl_oz: number | null;
  detail?: string;
}

export interface ShrinkageBackfillResult {
  mode: "apply" | "dry-run";
  summary: { total: number; changed: number; unchanged: number; skipped: number; errored: number };
  results: ShrinkageBackfillRowResult[];
}

interface ShrinkageRow {
  source_ref: string;
  recipe_id: string;
  occurred_at: string;
  remaining_fl_oz: number | string;
}

export async function backfillDraftShrinkage(
  db: SupabaseClient,
  { apply }: { apply: boolean },
): Promise<ShrinkageBackfillResult> {
  // Every stored swap, oldest first so the output reads chronologically.
  const { data: rowsRaw, error } = await db
    .from("draft_swap_shrinkage")
    .select("source_ref, recipe_id, occurred_at, remaining_fl_oz")
    .order("occurred_at", { ascending: true });
  if (error) throw new Error(error.message);
  const rows = (rowsRaw ?? []) as ShrinkageRow[];

  // recipe_id → draft SKU Square variation id. The row doesn't store it, so we
  // re-derive it the same way the live sync does: the recipe's draft link.
  const recipeIds = [...new Set(rows.map((r) => r.recipe_id))];
  const varByRecipe = new Map<string, string>();
  if (recipeIds.length) {
    const { data: links, error: linkErr } = await db
      .from("recipe_square_links")
      .select("recipe_id, square_variation_id")
      .eq("packaging", "draft")
      .in("recipe_id", recipeIds);
    if (linkErr) throw new Error(linkErr.message);
    for (const l of (links ?? []) as { recipe_id: string; square_variation_id: string | null }[]) {
      if (l.square_variation_id) varByRecipe.set(l.recipe_id, l.square_variation_id);
    }
  }

  const results: ShrinkageBackfillRowResult[] = [];
  let changed = 0, unchanged = 0, skipped = 0, errored = 0;

  for (const row of rows) {
    const oldVal = Number(row.remaining_fl_oz);
    const base = {
      source_ref: row.source_ref,
      recipe_id: row.recipe_id,
      occurred_at: row.occurred_at,
      old_remaining_fl_oz: oldVal,
    };

    const sqvar = varByRecipe.get(row.recipe_id);
    if (!sqvar) {
      skipped++;
      results.push({ ...base, status: "skipped_no_sku", new_remaining_fl_oz: null });
      continue;
    }

    let newVal: number | null;
    try {
      newVal = await reconstructRemainingFlOz(sqvar, row.occurred_at);
    } catch (e) {
      errored++;
      results.push({ ...base, status: "error", new_remaining_fl_oz: null, detail: e instanceof Error ? e.message : String(e) });
      continue;
    }

    // No physical-count anchor in the window (e.g. beyond Square's retention) —
    // leave the stored value alone rather than overwrite it with nothing.
    if (newVal === null) {
      skipped++;
      results.push({ ...base, status: "skipped_no_baseline", new_remaining_fl_oz: null });
      continue;
    }

    if (Math.abs(newVal - oldVal) <= EPS) {
      unchanged++;
      results.push({ ...base, status: "unchanged", new_remaining_fl_oz: newVal });
      continue;
    }

    if (apply) {
      const { error: upErr } = await db
        .from("draft_swap_shrinkage")
        .update({ remaining_fl_oz: newVal })
        .eq("source_ref", row.source_ref);
      if (upErr) {
        errored++;
        results.push({ ...base, status: "error", new_remaining_fl_oz: newVal, detail: upErr.message });
        continue;
      }
    }
    changed++;
    results.push({ ...base, status: apply ? "updated" : "would_update", new_remaining_fl_oz: newVal });
  }

  return {
    mode: apply ? "apply" : "dry-run",
    summary: { total: rows.length, changed, unchanged, skipped, errored },
    results,
  };
}
