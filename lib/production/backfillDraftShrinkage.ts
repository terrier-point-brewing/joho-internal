import { SupabaseClient } from "@supabase/supabase-js";
import { fetchOrderSales, fetchPhysicalCounts } from "@/lib/square/inventory";
import { aggregatePourFlOzByRecipe, loadDraftPourVariations } from "@/lib/taproom/draftPourConsumption";

// Rows written before the pour-ledger reconstruction fix stored the last full-keg
// physical count as `remaining_fl_oz` (pours were never subtracted), so shrinkage
// read near-100% and roughly constant. This one-off recomputes each stored row's
// remaining fl oz as `max(0, lastRecountBeforeSwap - poursBetween(recount, swap))`,
// anchored on the base draft SKU's physical counts and draft pour-variation SALES
// (not the base counting SKU) — the same formula the live capture now uses.
// `full_fl_oz` (the recount target, already correct) stays untouched. Dry-run
// unless `apply`.

const EPS = 1e-4;
// How far back to look for the physical count that anchors a swap's reconstruction.
const RECOUNT_WINDOW_DAYS = 60;

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

  // recipe_id → draft base SKU Square variation id. The row doesn't store it, so
  // we re-derive it the same way the live capture does: the recipe's draft link.
  const recipeIds = [...new Set(rows.map((r) => r.recipe_id))];
  const baseVarByRecipe = new Map<string, string>();
  if (recipeIds.length) {
    const { data: links, error: linkErr } = await db
      .from("recipe_square_links")
      .select("recipe_id, square_variation_id")
      .eq("packaging", "draft")
      .in("recipe_id", recipeIds);
    if (linkErr) throw new Error(linkErr.message);
    for (const l of (links ?? []) as { recipe_id: string; square_variation_id: string | null }[]) {
      if (l.square_variation_id) baseVarByRecipe.set(l.recipe_id, l.square_variation_id);
    }
  }

  // recipe_id → pour-size sibling variations (5oz/10oz/16oz), loaded once.
  const pourVarsByRecipe = await loadDraftPourVariations(db);

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

    const baseVarId = baseVarByRecipe.get(row.recipe_id);
    const pourVars = pourVarsByRecipe.get(row.recipe_id);
    if (!baseVarId || !pourVars || pourVars.length === 0) {
      skipped++;
      results.push({ ...base, status: "skipped_no_sku", new_remaining_fl_oz: null });
      continue;
    }

    try {
      const swapTime = row.occurred_at;
      const windowStartDate = new Date(
        new Date(swapTime).getTime() - RECOUNT_WINDOW_DAYS * 86400000,
      ).toISOString().slice(0, 10);
      const windowEndDate = swapTime.slice(0, 10);

      const counts = await fetchPhysicalCounts(windowStartDate, windowEndDate, [baseVarId]);
      // Latest physical count strictly before the swap anchors the reconstruction.
      const priorCounts = counts
        .filter((c) => c.occurred_at < swapTime)
        .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));
      const anchor = priorCounts[0];

      if (!anchor) {
        // No physical count precedes the swap within the window (e.g. beyond
        // Square's retention) — leave the stored value alone rather than
        // overwrite it with nothing.
        skipped++;
        results.push({ ...base, status: "skipped_no_baseline", new_remaining_fl_oz: null });
        continue;
      }

      const recountQty = Number(anchor.quantity);
      const recountTime = anchor.occurred_at;

      const pourVarIds = pourVars.map((v) => v.id);
      const sales = await fetchOrderSales(recountTime, swapTime, pourVarIds);
      const pourFlOz = aggregatePourFlOzByRecipe(sales, pourVarsByRecipe).get(row.recipe_id)?.flOz ?? 0;

      const newVal = Math.max(0, recountQty - pourFlOz);

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
        if (upErr) throw new Error(upErr.message);
      }
      changed++;
      results.push({ ...base, status: apply ? "updated" : "would_update", new_remaining_fl_oz: newVal });
    } catch (e) {
      errored++;
      results.push({ ...base, status: "error", new_remaining_fl_oz: null, detail: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    mode: apply ? "apply" : "dry-run",
    summary: { total: rows.length, changed, unchanged, skipped, errored },
    results,
  };
}
