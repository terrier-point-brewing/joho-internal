// lib/square/linkHealth.ts
//
// Is a recipe→Square mapping still pointed at something that exists?
//
// Square catalog objects are deleted and recreated by people working in the
// Square dashboard, and a recreated variation gets a NEW id. The app never writes
// to the Square catalog, so it cannot prevent this — it can only notice. Nothing
// noticed for nine days: 18 of 108 links pointed at variations that 404, reads
// against them returned nothing (which the caller read as "zero on hand"), and
// writes against them were accepted by Square without applying, so every failure
// looked like a success.
//
// Liveness is derived from the catalog mirror rather than from a Square round
// trip: the sync marks `is_deleted` on anything `/catalog/list` stops returning,
// so a link is dead when its variation has no live mirror row.

/** A mapping whose Square variation no longer exists. */
export interface DeadLink {
  linkId: string;
  recipeId: string;
  packaging: string;
  itemName: string | null;
  variationName: string | null;
  squareVariationId: string;
  /**
   * `deleted_in_square` — the mirror knows this variation and has flagged it gone.
   * `missing_from_catalog` — the mirror has never seen it at all, which means
   * either the sync has not run since it was mapped, or it was mapped by hand to
   * an id that was never real. Both need a human; they are distinguished so the
   * first can be resolved by running a sync.
   */
  reason: "deleted_in_square" | "missing_from_catalog";
}

export interface LinkRow {
  id: string;
  recipe_id: string;
  packaging: string;
  item_name: string | null;
  variation_name: string | null;
  square_variation_id: string;
}

/**
 * PURE: which links point at a variation that is not live?
 *
 * `liveVariationIds` is every non-deleted variation in the mirror;
 * `knownVariationIds` is every mirror row including deleted ones, and is what
 * separates "flagged as deleted" from "never seen".
 */
export function selectDeadLinks(
  links: LinkRow[],
  liveVariationIds: ReadonlySet<string>,
  knownVariationIds: ReadonlySet<string>,
): DeadLink[] {
  const dead: DeadLink[] = [];
  for (const l of links) {
    if (liveVariationIds.has(l.square_variation_id)) continue;
    dead.push({
      linkId: l.id,
      recipeId: l.recipe_id,
      packaging: l.packaging,
      itemName: l.item_name,
      variationName: l.variation_name,
      squareVariationId: l.square_variation_id,
      reason: knownVariationIds.has(l.square_variation_id)
        ? "deleted_in_square"
        : "missing_from_catalog",
    });
  }
  return dead;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (t: string) => any };

/**
 * Every mapping currently pointed at a variation that is not live in Square.
 * Reads the mirror only — no Square API call — so it is cheap enough to run on
 * every reconcile and to serve to the taproom Inventory tab.
 */
export async function findDeadLinks(db: Db): Promise<DeadLink[]> {
  const { data: links, error: linkErr } = await db
    .from("recipe_square_links")
    .select("id, recipe_id, packaging, item_name, variation_name, square_variation_id");
  if (linkErr) throw new Error(linkErr.message);

  const { data: vars, error: varErr } = await db
    .from("square_catalog_variations")
    .select("square_variation_id, is_deleted");
  if (varErr) throw new Error(varErr.message);

  const live = new Set<string>();
  const known = new Set<string>();
  for (const v of (vars ?? []) as { square_variation_id: string; is_deleted: boolean | null }[]) {
    known.add(v.square_variation_id);
    if (!v.is_deleted) live.add(v.square_variation_id);
  }

  return selectDeadLinks((links ?? []) as LinkRow[], live, known);
}
