import { SupabaseClient } from "@supabase/supabase-js";

/** The two columns every caller needs to identify what a shipment actually shipped. */
export interface ShippedVariationRef {
  recipe_id: string | null;
  variation_id?: string | null;
  variant_label: string | null;
}

/**
 * Resolve the packaging variation an export transaction shipped.
 *
 * `variation_id` is the answer whenever it is set. Rows written before that
 * column existed fall back to the old rule — match `variant_label` against
 * `packaging_variations.name`, scoped to the row's recipe, and accept it only
 * when exactly one candidate comes back.
 *
 * That fallback is the bug this column exists to end: the label is a snapshot
 * taken at ship time, so renaming a variation orphans every row shipped under
 * the old spelling, and the caller cannot tell "renamed" apart from "never
 * existed". Treat a null here as "unknown", never as "no materials" or "no
 * volume" — the callers each decide whether that is a warning or a hard stop.
 */
export async function resolveShippedVariationId(
  supabase: SupabaseClient,
  tx: ShippedVariationRef,
): Promise<string | null> {
  if (tx.variation_id) return tx.variation_id;
  if (!tx.recipe_id || !tx.variant_label) return null;

  const { data, error } = await supabase
    .from("recipe_packaging_variations")
    .select("variation_id, packaging_variations!inner(id, name)")
    .eq("recipe_id", tx.recipe_id)
    .eq("packaging_variations.name", tx.variant_label);
  if (error) throw new Error(error.message);
  if (!data || data.length !== 1) return null;
  return data[0].variation_id as string;
}
