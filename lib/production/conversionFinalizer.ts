import type { SupabaseClient } from "@supabase/supabase-js";

/** Batch status implied by the stage a batch occupies in a given equipment type. */
export function conversionTargetStatus(
  destType: string | null | undefined,
): "fermenting" | "conditioning" | null {
  switch (destType) {
    case "fermenter": return "fermenting";
    case "brite":     return "conditioning";
    default:          return null;
  }
}

/** Ordered lifecycle rank; higher = later. Unknown/null ranks lowest. */
export const STATUS_RANK: Record<string, number> = {
  planning: 0, brewing: 1, fermenting: 2, conditioning: 3, complete: 4,
};

/** True when `to` is a strictly later stage than `from` (forward-only guard). */
export function isForward(from: string | null | undefined, to: string): boolean {
  const fromRank = from != null && from in STATUS_RANK ? STATUS_RANK[from] : -1;
  const toRank = to in STATUS_RANK ? STATUS_RANK[to] : -1;
  return toRank > fromRank;
}

export async function createConversionTargetBatch(
  supabase: SupabaseClient,
  { sourceBatchId, beerName, recipeId, volumeBbl }: {
    sourceBatchId: string; beerName: string; recipeId: string; volumeBbl: number;
  },
): Promise<string> {
  const { data: parent } = await supabase
    .from("brew_batches").select("planned_brew_date").eq("id", sourceBatchId).single();

  const { data: child, error } = await supabase
    .from("brew_batches")
    .insert({
      beer_name:               beerName,
      recipe_id:               recipeId,
      volume_bbl:              volumeBbl,
      status:                  "planning",
      planned_brew_date:       (parent as { planned_brew_date: string | null } | null)?.planned_brew_date ?? null,
      converted_from_batch_id: sourceBatchId,
      converted_volume_bbl:    volumeBbl,
    })
    .select("id")
    .single();

  if (error || !child) throw new Error(error?.message ?? "Failed to create conversion target batch");
  return (child as { id: string }).id;
}
