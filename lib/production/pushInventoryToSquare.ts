// lib/production/pushInventoryToSquare.ts
//
// Project cold storage onto Square for every mapped keg and can SKU.
//
// Two things this fixes about how the push used to work:
//
//  1. It was a side effect of taproom CAN SALES. reconcileSquareCanInventory ran
//     inside the consumption sync, scoped to recipes that had sold cans in the
//     window, so a packaging run that added 500 cans pushed nothing and a
//     wholesale-only week pushed nothing at all. Square only ever heard about
//     beer that left through the till.
//  2. Kegs had no push whatsoever — 55 mapped SKUs, never written.
//
// The push is ABSOLUTE (PHYSICAL_COUNT), which is what makes it safe to run
// often and in any order: it states what is on hand rather than applying a
// delta, so whatever Square did on its own since the last run is simply
// overwritten. That is also why no push is needed on the export path — Square
// decrements itself when a wholesale invoice is paid, and the next run restates
// the truth either way.
//
// Gated by lib/square/pushGate. While the gate is shut this measures and reports
// without writing.

import type { SupabaseClient } from "@supabase/supabase-js";
import { reconcileSquareCanInventory } from "./reconcileSquareCanInventory";
import { measureKegDrift, type KegMeasurement } from "./kegDrift";
import { loadKegLinks } from "./kegLinks";
import { loadPendingDeductionRecipes } from "./pendingSquareDeduction";
import { fetchColdStorageOnHand } from "./coldStorageOnHand";
import { fetchCurrentCounts, setPhysicalCount } from "@/lib/square/inventory";
import { PUSH_TO_SQUARE_ENABLED, DRIFT_THRESHOLD } from "@/lib/square/pushGate";

const INT_EPS = 1e-6;

export interface PushOutcome {
  /** Corrections that cleared the threshold — sent when the gate is open. */
  planned: {
    packaging: "keg" | "can";
    recipeId: string;
    squareVariationId: string;
    label: string | null;
    coldStorageUnits: number;
    squareUnitsBefore: number;
    drift: number;
  }[];
  applied: number;
  /**
   * Recipes held back because Square still owes itself a deduction for stock
   * already shipped. Pushing them would consume the headroom that deduction is
   * about to take. See pendingSquareDeduction.
   */
  deferredRecipeIds: string[];
  warnings: string[];
  /** False while the gate is shut, so a caller can say why applied is 0. */
  pushEnabled: boolean;
}

/**
 * PURE: which measurements are worth a write?
 *
 * Fractional drift below the threshold is rounding and in-flight sales, not a
 * real gap. Writing it would put the app in a permanent tug-of-war with Square
 * over half a can.
 */
export function selectPushable<T extends { drift: number }>(
  measurements: T[],
  threshold = DRIFT_THRESHOLD,
): T[] {
  return measurements.filter((m) => Math.abs(m.drift) >= threshold);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient | { from: (t: string) => any };

/** Write one absolute count and confirm it landed. Returns null on success, else why not. */
async function writeAndVerify(
  squareVariationId: string,
  units: number,
  occurredAt: string,
): Promise<string | null> {
  await setPhysicalCount(squareVariationId, units, occurredAt);

  // Square accepts a physical count against a variation it does not have and
  // returns no error, so "the POST did not fail" says nothing about whether
  // anything changed. Read it back.
  const after = await fetchCurrentCounts([squareVariationId]);
  const observed = after.get(squareVariationId);
  if (observed === undefined || Math.abs(observed - units) > INT_EPS) {
    return `wrote ${units}, Square reports ${observed ?? "no count"}`;
  }
  return null;
}

async function pushKegs(
  db: Db,
  occurredAt: string,
  out: PushOutcome,
  deferred: ReadonlySet<string>,
): Promise<void> {
  const allLinks = await loadKegLinks(db);
  const links = allLinks.filter((l) => !deferred.has(l.recipeId));
  if (links.length === 0) return;

  const [coldStorage, counts] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetchColdStorageOnHand(db as any),
    fetchCurrentCounts(links.map((l) => l.squareVariationId)),
  ]);
  const squareCountByVar: Record<string, number> = {};
  for (const [id, qty] of counts) squareCountByVar[id] = qty;

  const { measurements, unmeasured } = measureKegDrift({ links, coldStorage, squareCountByVar });
  for (const u of unmeasured) {
    out.warnings.push(`keg ${u.variationName ?? u.squareVariationId}: ${u.reason}`);
  }

  for (const m of selectPushable<KegMeasurement>(measurements)) {
    out.planned.push({
      packaging: "keg",
      recipeId: m.recipeId,
      squareVariationId: m.squareVariationId,
      label: m.variationName,
      coldStorageUnits: m.coldStorageKegs,
      squareUnitsBefore: m.squareKegs,
      drift: m.drift,
    });

    if (!PUSH_TO_SQUARE_ENABLED) continue;
    try {
      const failure = await writeAndVerify(m.squareVariationId, m.coldStorageKegs, occurredAt);
      if (failure) {
        out.warnings.push(`keg write NOT verified for ${m.variationName ?? m.squareVariationId}: ${failure}`);
        continue;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any).from("square_inventory_reconciliations").insert({
        recipe_id: m.recipeId,
        packaging: "keg",
        base_square_variation_id: m.squareVariationId,
        base_variation_name: m.variationName,
        cold_storage_cans: m.coldStorageKegs,
        square_cans_before: m.squareKegs,
        drift: m.drift,
        occurred_at: occurredAt,
      });
      out.applied++;
    } catch (e) {
      out.warnings.push(`keg write failed for ${m.squareVariationId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * Reflect cold storage onto Square across every mapped keg and can SKU.
 *
 * `recipeIds` narrows the run — used by the creation-path triggers, which only
 * need to restate the recipe that just changed. Omit it for the periodic sweep,
 * which is the backstop that catches anything the triggers missed.
 */
export async function pushInventoryToSquare(
  db: Db,
  opts: { recipeIds?: string[]; occurredAt?: string } = {},
): Promise<PushOutcome> {
  const occurredAt = opts.occurredAt ?? new Date().toISOString();
  const out: PushOutcome = {
    planned: [], applied: 0, deferredRecipeIds: [], warnings: [], pushEnabled: PUSH_TO_SQUARE_ENABLED,
  };

  // Recipes Square is still going to decrement for itself. Pushing them now
  // would double-count the shipment: the push lowers Square to cold storage, and
  // the invoice then takes the same units again. Decided per shipment — invoice
  // line items once one exists, the channel's invoice shape before then — so a
  // contract-style shipment pushes at ship while a distribution one waits out
  // its invoice. See pendingSquareDeduction for the three shipment models.
  let deferred: ReadonlySet<string> = new Set();
  try {
    deferred = await loadPendingDeductionRecipes(db);
  } catch (e) {
    // Failing open here would double-count real inventory, so refuse to push at
    // all rather than push blind.
    out.warnings.push(`push skipped — could not determine pending Square deductions: ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }

  const scoped = opts.recipeIds?.filter((id) => !deferred.has(id));
  out.deferredRecipeIds = [...(opts.recipeIds ?? []).filter((id) => deferred.has(id))];
  // A trigger scoped entirely to deferred recipes has nothing left to do.
  if (opts.recipeIds && scoped!.length === 0) return out;

  // Cans: the family/tier resolution lives in the reconciler, which already
  // writes, verifies and journals behind the same gate.
  try {
    const canPlan = await reconcileSquareCanInventory(db, {
      ...(scoped ? { recipeIds: scoped } : {}),
      // Passed IN rather than filtered out of the result: the reconciler writes
      // as it goes, so a post-filter would remove the row from the report after
      // the double-count had already been sent.
      skipRecipeIds: [...deferred],
      occurredAt,
    });
    out.applied += canPlan.applied;
    out.warnings.push(...canPlan.warnings);
    // A skipped family is not a quiet family. Dropping these made "could not be
    // measured" and "measured, and the two sides agree" produce identical run
    // detail: zero planned writes, no warnings. That is how the loose-tier blind
    // spot hid 684 cans for as long as it did, and how the stale-link outage went
    // nine days. Whatever the reconciler could not answer for, say so.
    for (const s of canPlan.skips) {
      out.warnings.push(`can family not measured for recipe ${s.recipeId}: ${s.reason}`);
    }
    for (const w of canPlan.writes) {
      out.planned.push({
        packaging: "can",
        recipeId: w.recipeId,
        squareVariationId: w.baseSquareVariationId,
        label: w.baseVariationName,
        coldStorageUnits: w.coldStorageCans,
        squareUnitsBefore: w.squareCansBefore,
        drift: w.drift,
      });
    }
  } catch (e) {
    out.warnings.push(`can push failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Kegs: no tiers, but the same one-Square-SKU-many-cold-storage-rows grain, so
  // the sum is what gets written.
  try {
    await pushKegs(db, occurredAt, out, deferred);
  } catch (e) {
    out.warnings.push(`keg push failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return out;
}
