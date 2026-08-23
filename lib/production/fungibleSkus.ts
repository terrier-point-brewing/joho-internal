// lib/production/fungibleSkus.ts
//
// Reads `square_fungible_skus` — the declaration that one Square variation may
// be filled from any packaging variation linked to it (see the table's own
// migration for why). Keyed on (recipe, Square variation), because the same
// Square button can legitimately mean different things for different beers.
//
// Everything here is a READ of a declaration. Nothing infers a group from the
// shape of the data: two links sharing a SKU with no row in this table is the
// pre-existing ambiguity `selectSaleLink` reports, and must keep being reported.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = { from: (table: string) => any };

/** `${recipeId}\t${squareVariationId}` — the grain of a declaration. */
export type FungibleKey = string;

export function fungibleKey(recipeId: string, squareVariationId: string): FungibleKey {
  return `${recipeId}\t${squareVariationId}`;
}

/**
 * Every declared group, as a set of keys. One query — the table is small (one
 * row per deliberately-shared button) and every caller wants membership lookups,
 * not rows.
 */
export async function fetchFungibleSkus(db: DbClient): Promise<Set<FungibleKey>> {
  const { data, error } = await db
    .from("square_fungible_skus")
    .select("recipe_id, square_variation_id");
  if (error) throw new Error(error.message);
  const out = new Set<FungibleKey>();
  for (const r of (data ?? []) as { recipe_id: string; square_variation_id: string }[]) {
    out.add(fungibleKey(r.recipe_id, r.square_variation_id));
  }
  return out;
}

/**
 * Declare a SKU fungible for a recipe. Idempotent — re-declaring an existing
 * group is a no-op rather than an error, so the drawer can send it without
 * first checking.
 */
export async function declareFungible(
  db: DbClient,
  { recipeId, squareVariationId }: { recipeId: string; squareVariationId: string },
): Promise<void> {
  const { error } = await db
    .from("square_fungible_skus")
    .upsert({ recipe_id: recipeId, square_variation_id: squareVariationId }, { onConflict: "recipe_id,square_variation_id" });
  if (error) throw new Error(error.message);
}

/**
 * Drop a declaration once it no longer describes anything.
 *
 * A group of one is not a group: if unlinking leaves a single packaging behind
 * the button, the declaration is dead config that would silently re-arm the next
 * time someone linked a second packaging there. Called after every link DELETE,
 * so removing a member is the whole gesture — there is no separate "unshare".
 */
export async function pruneEmptyFungibleDeclarations(
  db: DbClient,
  { recipeId, squareVariationId }: { recipeId: string; squareVariationId: string },
): Promise<void> {
  const { data, error } = await db
    .from("recipe_square_links")
    .select("id")
    .eq("recipe_id", recipeId)
    .eq("square_variation_id", squareVariationId);
  if (error) throw new Error(error.message);
  if ((data ?? []).length >= 2) return;

  const { error: delErr } = await db
    .from("square_fungible_skus")
    .delete()
    .eq("recipe_id", recipeId)
    .eq("square_variation_id", squareVariationId);
  if (delErr) throw new Error(delErr.message);
}
