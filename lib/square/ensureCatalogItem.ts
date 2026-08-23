// lib/square/ensureCatalogItem.ts
//
// Closes the seam between how a link is CREATED and how it is READ.
//
// The mapping picker reads Square's catalog LIVE (see
// app/api/production/square-catalog/route.ts, which calls fetchCatalogItems
// directly), so an operator can pick and link a SKU created moments ago and the
// grid shows it as linked. Every backend consumer, however, reads the mirror —
// sell-through, the draft pour sizes, the mapping grid, the inventory push. The
// mirror is only refreshed when a human clicks "Refresh from Square".
//
// So a link to a new SKU is valid, displays as linked, and is invisible to the
// backend until someone happens to press that button. Pumpkin Ale went on tap
// with its draft and cans items linked and neither present in the mirror; the
// pour sizes could not be resolved, so its shrinkage could not be measured and
// Draft Stats had nothing to show for the tap.
//
// This pulls the linked item into the mirror at the moment the link is made,
// scoped to that one item so the deletion pass never runs.

import type { SupabaseClient } from "@supabase/supabase-js";
import { syncSquareCatalog } from "./syncCatalog";
import { applyGlDefaultRulesToNewVariations } from "@/lib/finance/glDefaultRules";

export interface EnsureResult {
  /** True when the mirror already had the variation and nothing was fetched. */
  alreadyMirrored: boolean;
  /** True when a scoped sync ran and the variation is now present. */
  synced: boolean;
  /** Why it could not be mirrored, when it could not. Never thrown. */
  warning?: string;
}

/**
 * Make sure `squareVariationId` is present in the mirror, pulling its parent
 * item in if not.
 *
 * BEST EFFORT BY DESIGN. A link save must never fail because Square was
 * unreachable — the link itself is still correct, and the next full sync will
 * pick the item up. Callers surface `warning` rather than erroring.
 *
 * The caller is responsible for busting the live-catalog cache first when the
 * item may have been created within the cache window; see
 * `revalidateTag("square-catalog")` in the sync-catalog route.
 */
export async function ensureCatalogItemMirrored(
  db: SupabaseClient,
  { squareItemId, squareVariationId }: { squareItemId: string; squareVariationId: string },
): Promise<EnsureResult> {
  try {
    const { data, error } = await db
      .from("square_catalog_variations")
      .select("square_variation_id")
      .eq("square_variation_id", squareVariationId)
      .limit(1);
    if (error) throw new Error(error.message);
    if ((data ?? []).length > 0) return { alreadyMirrored: true, synced: false };

    const result = await syncSquareCatalog(db, { onlyItemIds: [squareItemId] });
    if (result.variations === 0) {
      return {
        alreadyMirrored: false,
        synced: false,
        warning: `Square returned no variations for item ${squareItemId}; the link is saved but the catalog mirror has not caught up.`,
      };
    }
    // Same standing GL defaults the full sync applies — a variation pulled in by
    // a link is just as new to the mirror. Swallows its own errors.
    await applyGlDefaultRulesToNewVariations(db, result.insertedVariationIds);

    return { alreadyMirrored: false, synced: true };
  } catch (e) {
    return {
      alreadyMirrored: false,
      synced: false,
      warning: e instanceof Error ? e.message : String(e),
    };
  }
}
