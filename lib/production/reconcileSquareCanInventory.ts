// lib/production/reconcileSquareCanInventory.ts
//
// Cold storage is the source of truth for can inventory; Square tracks loose cans
// on each family's base ("Regular"/loose) variation and derives 4-pack/case
// quantities itself. This reconciler pushes cold storage's loose-can total onto
// that base Square variation whenever they drift, and journals each correction to
// square_inventory_reconciliations so the taproom Inventory subtab can show it.
//
// Grain: one write per (recipe × can-identity family). Cold storage always trumps;
// Square is never read back into cold storage.

import type { SupabaseClient } from "@supabase/supabase-js";
import { deriveCansEach } from "./coldStorageBreak";
import { groupCanFamilies, type FamilyPackagingRow } from "./canIdentityFamily";
import { resolveProductSku } from "@/lib/square/skuMappings";
import { fetchCurrentCounts, setPhysicalCount } from "@/lib/square/inventory";
import { PUSH_TO_SQUARE_ENABLED, DRIFT_THRESHOLD } from "@/lib/square/pushGate";

const INT_EPS = 1e-6;

// ── Base-variation resolution (pure) ─────────────────────────────────────────

export interface ItemVariation {
  squareVariationId: string;
  variationName: string;
  volumeFlOzPerUnit: number | null;
  trackInventory: boolean;
}

/** Stem before the size/format suffix: "Regular - 16oz Case" -> "Regular". */
export function variantStem(variationName: string): string {
  return variationName.split(" - ")[0].trim();
}

/**
 * The family's base (loose-can-tracked) Square variation is the item's PARENT
 * variation — volume_fl_oz_per_unit IS NULL, i.e. "Regular" / "Be Like Mike".
 * When an item has more than one parent (Regular vs a labeled variant),
 * disambiguate by variant stem. Requires track_inventory=true; returns null when
 * no tracked parent matches (e.g. Be Like Mike is untracked) or the match is
 * ambiguous — the caller then skips the family rather than risk a wrong write.
 */
export function pickBaseVariation(input: { itemVariations: ItemVariation[]; stem: string | null }): ItemVariation | null {
  const parents = input.itemVariations.filter((v) => v.volumeFlOzPerUnit == null);
  let candidates = parents;
  if (input.stem) {
    const matched = parents.filter((v) => variantStem(v.variationName) === input.stem);
    if (matched.length > 0) candidates = matched;
  }
  const tracked = candidates.filter((v) => v.trackInventory);
  return tracked.length === 1 ? tracked[0] : null;
}

export interface ReconcileFamilyInput {
  recipeId: string;
  baseSquareVariationId: string | null;
  baseVariationName: string | null;
  cansEachByVar: Record<string, number>;
  onHandByVar: Record<string, number>;
}

export interface ReconcileWrite {
  recipeId: string;
  baseSquareVariationId: string;
  baseVariationName: string | null;
  coldStorageCans: number;
  squareCansBefore: number;
  drift: number; // squareCansBefore - coldStorageCans
}

/**
 * What the two sides say for one can family, whether or not they disagree enough
 * to be worth a write.
 *
 * `components` is the decomposition: the per-tier on-hand and how many loose cans
 * each tier is worth, which multiply and sum to `coldStorageCans`. A variance you
 * cannot break into the slices that produce it is not reviewable, so the drift
 * view is given the slices rather than just the total.
 */
export interface FamilyMeasurement {
  recipeId: string;
  baseSquareVariationId: string;
  baseVariationName: string | null;
  coldStorageCans: number;
  squareCans: number;
  drift: number; // squareCans - coldStorageCans
  components: { variationId: string; cansEach: number; onHand: number }[];
}

export interface ReconcilePlan {
  /** Families whose drift clears the threshold — the subset worth writing. */
  writes: ReconcileWrite[];
  /** EVERY family both sides could be read for, drift or not. Feeds the drift view. */
  measurements: FamilyMeasurement[];
  skips: { recipeId: string; reason: string }[];
  warnings: string[];
}

export function planCanReconciliation(input: {
  families: ReconcileFamilyInput[];
  squareCountByVar: Record<string, number>;
  threshold?: number;
}): ReconcilePlan {
  const threshold = input.threshold ?? DRIFT_THRESHOLD;
  const plan: ReconcilePlan = { writes: [], measurements: [], skips: [], warnings: [] };

  for (const fam of input.families) {
    if (!fam.baseSquareVariationId) {
      plan.skips.push({ recipeId: fam.recipeId, reason: "no base Square variation for family" });
      continue;
    }
    let raw = 0;
    for (const [varId, cansEach] of Object.entries(fam.cansEachByVar)) {
      raw += cansEach * (fam.onHandByVar[varId] ?? 0);
    }
    const coldStorageCans = Math.round(raw);
    if (Math.abs(raw - coldStorageCans) > INT_EPS) {
      plan.warnings.push(`${fam.recipeId} ${fam.baseVariationName ?? fam.baseSquareVariationId}: fractional loose-equivalent ${raw.toFixed(3)} rounded to ${coldStorageCans}`);
    }
    // ABSENT IS NOT ZERO. Square returns no count row for a variation it does not
    // track — or does not have at all. Reading that as 0 is what invented a
    // permanent -158 drift against a deleted variation and drove 1,040 writes
    // that could never converge. An unknown count is not a measurement, so there
    // is nothing to correct toward and the family is skipped.
    const squareCansBefore = input.squareCountByVar[fam.baseSquareVariationId];
    if (squareCansBefore === undefined) {
      plan.skips.push({
        recipeId: fam.recipeId,
        reason: `Square returned no count for ${fam.baseVariationName ?? fam.baseSquareVariationId} — unknown, not zero`,
      });
      continue;
    }
    const drift = squareCansBefore - coldStorageCans;

    // Recorded for every family, not just the ones over threshold: a family that
    // ties is exactly as interesting to a reader checking whether the two systems
    // agree as one that does not.
    plan.measurements.push({
      recipeId: fam.recipeId,
      baseSquareVariationId: fam.baseSquareVariationId,
      baseVariationName: fam.baseVariationName,
      coldStorageCans,
      squareCans: squareCansBefore,
      drift,
      components: Object.entries(fam.cansEachByVar).map(([variationId, cansEach]) => ({
        variationId,
        cansEach,
        onHand: fam.onHandByVar[variationId] ?? 0,
      })),
    });

    if (Math.abs(drift) >= threshold) {
      plan.writes.push({
        recipeId: fam.recipeId,
        baseSquareVariationId: fam.baseSquareVariationId,
        baseVariationName: fam.baseVariationName,
        coldStorageCans,
        squareCansBefore,
        drift,
      });
    }
  }
  return plan;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient | { from: (t: string) => any };

export async function reconcileSquareCanInventory(
  supabase: Db,
  opts: {
    recipeIds?: string[];
    /**
     * Recipes to measure but never write. Square still owes itself a deduction
     * for these (shipped, invoice not settled), so writing now would double-count
     * the shipment. See lib/production/pendingSquareDeduction.
     */
    skipRecipeIds?: string[];
    occurredAt?: string;
  } = {},
): Promise<ReconcilePlan & { applied: number }> {
  const occurredAt = opts.occurredAt ?? new Date().toISOString();
  const skip = new Set(opts.skipRecipeIds ?? []);

  // 1. Load cold-storage can rows (optionally scoped) with the packaging identity + volume.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = (supabase as any)
    .from("cold_storage_inventory")
    .select(
      "recipe_id, variation_id, quantity_on_hand, " +
      "packaging_variations!inner ( id, format, total_volume_fl_oz, container_id, lid_id, label_id, partner_id, packaging_items:container_id ( type ) )",
    );
  if (opts.recipeIds && opts.recipeIds.length > 0) q = q.in("recipe_id", opts.recipeIds);
  const { data, error } = await q as { data: Record<string, unknown>[] | null; error: { message: string } | null };
  if (error) throw new Error(error.message);

  // 2. Group rows by recipe, then into can-identity families; accumulate on-hand per variation.
  interface Loaded { row: FamilyPackagingRow; recipeId: string; onHand: number }
  const byRecipe = new Map<string, Loaded[]>();
  for (const r of data ?? []) {
    const pv = r.packaging_variations as unknown as {
      id: string; format: string; total_volume_fl_oz: number | null;
      container_id: string; lid_id: string | null; label_id: string | null; partner_id: string | null;
      packaging_items: { type: string } | null;
    } | null;
    if (!pv || pv.packaging_items?.type !== "can" || pv.total_volume_fl_oz == null || r.recipe_id == null) continue;
    const recipeId = r.recipe_id as string;
    const list = byRecipe.get(recipeId) ?? [];
    list.push({
      recipeId,
      onHand: Number(r.quantity_on_hand),
      row: {
        id: pv.id, format: pv.format, container_id: pv.container_id,
        lid_id: pv.lid_id, label_id: pv.label_id, partner_id: pv.partner_id,
        total_volume_fl_oz: Number(pv.total_volume_fl_oz),
      },
    });
    byRecipe.set(recipeId, list);
  }

  const families: ReconcileFamilyInput[] = [];
  const preWarnings: string[] = [];
  const preSkips: { recipeId: string; reason: string }[] = [];

  for (const [recipeId, loaded] of byRecipe) {
    // Sum on-hand per variation (batches collapse) and dedupe the packaging rows.
    const onHandByVar: Record<string, number> = {};
    const rowById = new Map<string, FamilyPackagingRow>();
    for (const l of loaded) {
      onHandByVar[l.row.id] = (onHandByVar[l.row.id] ?? 0) + l.onHand;
      rowById.set(l.row.id, l.row);
    }
    for (const famRows of groupCanFamilies([...rowById.values()])) {
      let derived;
      try {
        derived = deriveCansEach({
          variations: famRows.map((v) => ({ variationId: v.id, format: v.format, totalVolumeFlOz: v.total_volume_fl_oz })),
        });
      } catch {
        preSkips.push({ recipeId, reason: "family has no loose base variation" });
        continue;
      }
      preWarnings.push(...derived.warnings);
      const cansEachByVar: Record<string, number> = {};
      for (const t of derived.tiers) cansEachByVar[t.variationId] = t.cansEach;

      // Resolve the family's base Square variation via the Square ITEM + variant
      // stem (NOT the loose tier's own link, which can be mis-mapped — audited
      // case: a loose link pointing at the 4-Pack sale unit). Resolve each tier's
      // link, take the item id from whichever resolve, take the stem from a
      // NON-loose tier's name when available, then pick the item's tracked parent.
      const tierLinks = (await Promise.all(
        derived.tiers.map(async (t) => {
          try {
            return {
              format: t.format,
              sku: await resolveProductSku(supabase, { kind: "packaged", variationId: t.variationId, recipeId }),
            };
          } catch {
            // A single broken/duplicate link (e.g. a `.maybeSingle()` throwing on
            // more than one row) should not abort the whole reconcile run —
            // just skip this tier's contribution to base-variation resolution.
            return { format: t.format, sku: null };
          }
        }),
      )).filter((x) => x.sku);
      const itemId = tierLinks.map((x) => x.sku!.squareItemId).find((id): id is string => !!id) ?? null;
      const stemSource = tierLinks.find((x) => x.format !== "loose") ?? tierLinks[0];
      const stem = stemSource?.sku?.variationName ? variantStem(stemSource.sku.variationName) : null;

      let base: ItemVariation | null = null;
      if (itemId) {
        // Live variations only. The mirror keeps rows for variations Square has
        // deleted so their mappings stay inspectable, but a ghost must never be
        // a candidate for the base variation — Wiggo! IPA's item carries three
        // deleted rows alongside its live ones.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: itemVars } = await (supabase as any)
          .from("square_catalog_variations")
          .select("square_variation_id, variation_name, volume_fl_oz_per_unit, track_inventory")
          .eq("square_item_id", itemId)
          .eq("is_deleted", false);
        base = pickBaseVariation({
          itemVariations: ((itemVars ?? []) as Record<string, unknown>[]).map((v) => ({
            squareVariationId: v.square_variation_id as string,
            variationName: (v.variation_name as string) ?? "",
            volumeFlOzPerUnit: (v.volume_fl_oz_per_unit as number | null) ?? null,
            trackInventory: Boolean(v.track_inventory),
          })),
          stem,
        });
      }
      if (!base) {
        preSkips.push({ recipeId, reason: `no inventory-tracked base variation (item ${itemId ?? "?"}, stem ${stem ?? "?"})` });
      }
      families.push({
        recipeId,
        baseSquareVariationId: base?.squareVariationId ?? null,
        baseVariationName: base?.variationName ?? null,
        cansEachByVar,
        onHandByVar,
      });
    }
  }

  // 3. Read current Square counts for the base variations we might write.
  const baseVarIds = [...new Set(families.map((f) => f.baseSquareVariationId).filter((x): x is string => !!x))];
  const counts = baseVarIds.length ? await fetchCurrentCounts(baseVarIds) : new Map<string, number>();
  // Only ids Square actually answered for. A missing key means "unknown" and the
  // planner skips it; see the ABSENT IS NOT ZERO note in planCanReconciliation.
  const squareCountByVar: Record<string, number> = {};
  for (const id of baseVarIds) {
    const c = counts.get(id);
    if (c !== undefined) squareCountByVar[id] = c;
  }

  // 4. Plan, then execute writes (cold storage trumps) + journal each correction.
  const plan = planCanReconciliation({ families, squareCountByVar });
  plan.warnings.unshift(...preWarnings);
  plan.skips.unshift(...preSkips);

  let applied = 0;
  for (const w of plan.writes) {
    // Measured and reported, deliberately not written: Square is going to
    // decrement this recipe itself when its shipment's invoice settles, and
    // restating the count now would let that deduction take the same units a
    // second time.
    if (skip.has(w.recipeId)) {
      plan.skips.push({ recipeId: w.recipeId, reason: "awaiting Square's own deduction for a shipped order — push deferred" });
      continue;
    }
    // `plan.writes` carries every intended correction whether or not the gate is
    // open, so drift stays fully visible in the run summary and on the taproom
    // Inventory tab; only the Square mutation is withheld. See lib/square/pushGate.
    if (!PUSH_TO_SQUARE_ENABLED) continue;
    try {
      await setPhysicalCount(w.baseSquareVariationId, w.coldStorageCans, occurredAt);

      // VERIFY THE WRITE LANDED. Square accepts a PHYSICAL_COUNT against a
      // variation it does not have and returns no error, so "the POST did not
      // fail" says nothing about whether anything changed. Read the count back
      // and insist it matches before claiming the correction was applied.
      const after = await fetchCurrentCounts([w.baseSquareVariationId]);
      const observed = after.get(w.baseSquareVariationId);
      if (observed === undefined || Math.abs(observed - w.coldStorageCans) > INT_EPS) {
        plan.warnings.push(
          `write NOT verified for ${w.baseVariationName ?? w.baseSquareVariationId}: ` +
          `wrote ${w.coldStorageCans}, Square reports ${observed ?? "no count"}`,
        );
        continue;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any).from("square_inventory_reconciliations").insert({
        recipe_id: w.recipeId,
        base_square_variation_id: w.baseSquareVariationId,
        base_variation_name: w.baseVariationName,
        cold_storage_cans: w.coldStorageCans,
        square_cans_before: w.squareCansBefore,
        drift: w.drift,
        occurred_at: occurredAt,
      });
      applied++;
    } catch (e) {
      plan.warnings.push(`write failed for ${w.baseSquareVariationId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { ...plan, applied };
}
