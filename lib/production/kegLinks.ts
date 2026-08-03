// lib/production/kegLinks.ts
//
// The mapped keg SKUs, loaded once and shared by the drift view and the push.
// Kept separate so the two can never disagree about which links count — a
// measurement that says "these agree" has to be about the same set the push
// would write.

import type { KegLink } from "./kegDrift";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (t: string) => any };

export async function loadKegLinks(db: Db): Promise<KegLink[]> {
  const { data, error } = await db
    .from("recipe_square_links")
    .select("recipe_id, variation_id, square_variation_id, variation_name, packaging_variations:variation_id ( name )")
    .eq("packaging", "keg");
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as {
    recipe_id: string; variation_id: string | null;
    square_variation_id: string; variation_name: string | null;
    packaging_variations: { name: string | null } | null;
  }[];

  // A keg link with no cold-storage variation has no app-side quantity to hold
  // against Square's, so it cannot be compared or pushed. The consumption sync
  // reports it as `link_missing_cold_storage_variation` rather than it being
  // silently treated as zero here.
  return rows
    .filter((r) => r.variation_id)
    .map((r) => ({
      recipeId: r.recipe_id,
      variationId: r.variation_id!,
      squareVariationId: r.square_variation_id,
      variationName: r.variation_name,
      coldStorageLabel: r.packaging_variations?.name ?? null,
    }));
}
