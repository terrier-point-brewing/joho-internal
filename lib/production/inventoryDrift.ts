// lib/production/inventoryDrift.ts
//
// Where do Square and cold storage disagree, and by how much?
//
// This is the measurement that the taproom Inventory tab renders. It is the only
// place the two systems are compared side by side; before it existed, drift was
// invisible unless someone ran SQL by hand, which is how a stale mapping went
// nine days without anyone noticing.
//
// Read-only. Nothing here writes to Square or to cold storage.

import type { SupabaseClient } from "@supabase/supabase-js";
import { reconcileSquareCanInventory, type FamilyMeasurement } from "./reconcileSquareCanInventory";
import { measureKegDrift, type KegLink, type KegMeasurement, type KegUnmeasured } from "./kegDrift";
import { fetchColdStorageOnHand } from "./coldStorageOnHand";
import { fetchCurrentCounts } from "@/lib/square/inventory";
import { findDeadLinks, type DeadLink } from "@/lib/square/linkHealth";

export interface InventoryDrift {
  cans: FamilyMeasurement[];
  kegs: KegMeasurement[];
  /** Mappings pointed at a variation that is not live in Square. */
  deadLinks: DeadLink[];
  /** Comparable in principle, but one side could not be read this run. */
  unmeasured: (KegUnmeasured | { recipeId: string; reason: string })[];
  warnings: string[];
  /** Beer names for every recipe referenced above, so the UI needs no second call. */
  recipeNames: Record<string, string>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient | { from: (t: string) => any };

async function loadKegLinks(db: Db): Promise<KegLink[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from("recipe_square_links")
    .select("recipe_id, variation_id, square_variation_id, variation_name, packaging_variations:variation_id ( name )")
    .eq("packaging", "keg");
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as {
    recipe_id: string; variation_id: string | null;
    square_variation_id: string; variation_name: string | null;
    packaging_variations: { name: string | null } | null;
  }[];

  // A keg link with no cold-storage variation cannot be compared — there is no
  // app-side quantity to hold against Square's. Surfaced by findDeadLinks-adjacent
  // mapping work rather than silently measured as zero.
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

async function loadRecipeNames(db: Db, recipeIds: string[]): Promise<Record<string, string>> {
  if (recipeIds.length === 0) return {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from("recipes")
    .select("id, beer_name")
    .in("id", [...new Set(recipeIds)]);
  if (error) throw new Error(error.message);
  const out: Record<string, string> = {};
  for (const r of (data ?? []) as { id: string; beer_name: string | null }[]) {
    out[r.id] = r.beer_name ?? "";
  }
  return out;
}

export async function measureInventoryDrift(db: Db): Promise<InventoryDrift> {
  const warnings: string[] = [];

  // Cans reuse the reconciler's family/tier resolution rather than reimplementing
  // it. Safe to call for a read: the push is observe-only, so it measures and
  // plans without mutating Square. See PUSH_TO_SQUARE_ENABLED.
  let cans: FamilyMeasurement[] = [];
  try {
    const plan = await reconcileSquareCanInventory(db);
    cans = plan.measurements;
    warnings.push(...plan.warnings);
  } catch (e) {
    warnings.push(`can drift unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Kegs: one cold-storage row against one Square count, no tiers involved.
  let kegs: KegMeasurement[] = [];
  let kegUnmeasured: KegUnmeasured[] = [];
  try {
    const links = await loadKegLinks(db);
    if (links.length > 0) {
      const [coldStorage, counts] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchColdStorageOnHand(db as any),
        fetchCurrentCounts(links.map((l) => l.squareVariationId)),
      ]);
      const squareCountByVar: Record<string, number> = {};
      for (const [id, qty] of counts) squareCountByVar[id] = qty;

      const res = measureKegDrift({ links, coldStorage, squareCountByVar });
      kegs = res.measurements;
      kegUnmeasured = res.unmeasured;
    }
  } catch (e) {
    warnings.push(`keg drift unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }

  let deadLinks: DeadLink[] = [];
  try {
    deadLinks = await findDeadLinks(db);
  } catch (e) {
    warnings.push(`link health unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }

  const recipeNames = await loadRecipeNames(db, [
    ...cans.map((c) => c.recipeId),
    ...kegs.map((k) => k.recipeId),
    ...deadLinks.map((d) => d.recipeId),
    ...kegUnmeasured.map((u) => u.recipeId),
  ]);

  return { cans, kegs, deadLinks, unmeasured: kegUnmeasured, warnings, recipeNames };
}
