// lib/production/coldStorageRecipeConversion.ts
//
// Convert kegs or cans ALREADY in cold storage from one recipe to another.
//
// The in-keg conversion (transfers route, `packaged_as_recipe_id`) covers a dose
// that goes in at the filler. This covers the dose that goes in later: the kegs
// sat in the cold room as Carolina Mule, then got re-dosed and are Transfusion
// Lager now. Commercially it is the same event — the beer has to become a
// conversion CHILD batch so it can be allocated, credited, deposit-billed and
// costed under the beer it actually is — but physically nothing moves except
// which lot the units sit in.
//
// WHAT GETS WRITTEN, in order:
//
//   1. the child batch — a pending in-keg PLAN for this source+recipe is
//      resolved onto, an existing child of the same source+recipe is reused,
//      otherwise one is minted born-complete (never two children of one
//      source+recipe; see findExistingConversionChild).
//   2. a packaging REVERSAL on the source: a kegging/canning row with NEGATIVE
//      volume and quantity. Every reader of "what did this batch package" sums
//      kegging/canning rows — batch_exhaustion, fulfillment, the partner
//      portal, intake demand, costing — so the negative row nets each of them
//      down by exactly the beer that stopped being this recipe.
//   3. a CONVERSION row on the source, to_batch_id = child, no tanks (the kegs
//      were never in a vessel). Costing follows it to the child; exhaustion
//      counts it as converted, so kegged + converted still ties to volume.
//   4. a packaging row on the CHILD from nowhere to nowhere — the shape an
//      in-keg child's rows already take, which computeLocationBreakdown reads
//      as finished goods.
//   5. the lot move, atomically, via move_cold_storage_lot_to_batch.
//   6. the follow-ups a tank conversion gets: batch_conversions record,
//      ingredient additions charged against the child, child completed, the
//      source's commitments re-judged, Square restated for both beers.
//
// Steps 2–4 are committed movements and are not rolled back by a later failure
// (same convention as the transfers route). Step 5 is the beer itself: if it
// fails the caller gets a ConversionError whose message says so in plain
// words, and the child's packaging row is stamped, so finished goods can never
// go missing quietly.

import type { SupabaseClient } from "@supabase/supabase-js";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";
import {
  completeConversionChild,
  createConversionTargetBatch,
  findExistingConversionChild,
  findPendingConversionPlan,
  priorConversionInflowBbl,
  recordExecutedConversion,
} from "./conversionFinalizer";
import { consumeConversionAdditions, isChargeableConversion, type ConsumeConversionResult } from "./conversionIngredients";
import { recheckBatchCommitments } from "./commitmentFulfillment";
import { triggerSquarePush } from "./triggerSquarePush";

export class ConversionError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface ConvertLotArgs {
  lotId: string;
  targetRecipeId: string;
  /** Whole units of the lot's packaging variation to convert. */
  units: number;
  note?: string | null;
  createdBy?: string | null;
}

export interface ConvertLotResult {
  childBatchId: string;
  childBatchNumber: string | null;
  sourceBatchId: string;
  sourceRecipeId: string;
  targetRecipeId: string;
  variationId: string;
  units: number;
  volumeBbl: number;
  additions: ConsumeConversionResult["status"];
}

/** bbl held by `units` containers of `flOzEach`. 4 dp, like every ledger volume. */
export function unitsToBbl(units: number, flOzEach: number): number {
  return Math.round(((units * flOzEach) / BBL_TO_FL_OZ) * 10000) / 10000;
}

/** A lot can only be converted in whole containers, and only what is there. */
export function validateUnits(units: number, onHand: number): string | null {
  if (!Number.isInteger(units) || units < 1) return "Units must be a whole number of at least 1.";
  if (units > onHand + 0.0001) return `That lot only holds ${onHand}. You can't convert more than is there.`;
  return null;
}

interface LotRow {
  id: string;
  batch_id: string;
  recipe_id: string | null;
  variation_id: string;
  quantity_on_hand: number;
  packaging_variations: {
    name: string | null;
    total_volume_fl_oz: number | null;
    partner_id: string | null;
    is_active: boolean | null;
    container: { type: string | null } | null;
  } | null;
}

export async function convertColdStorageLot(
  supabase: SupabaseClient,
  { lotId, targetRecipeId, units, note, createdBy }: ConvertLotArgs,
): Promise<ConvertLotResult> {
  // ── Read and validate everything before a single write ──────────────────
  const { data: lotData, error: lotErr } = await supabase
    .from("cold_storage_inventory")
    .select(
      "id, batch_id, recipe_id, variation_id, quantity_on_hand, " +
      "packaging_variations(name, total_volume_fl_oz, partner_id, is_active, " +
      "container:packaging_items!packaging_variations_container_id_fkey(type))",
    )
    .eq("id", lotId)
    .maybeSingle();
  if (lotErr) throw new ConversionError(lotErr.message, 500);
  const lot = lotData as unknown as LotRow | null;
  if (!lot) throw new ConversionError("That cold storage lot no longer exists.", 404);

  const onHand = Number(lot.quantity_on_hand);
  const unitsError = validateUnits(units, onHand);
  if (unitsError) throw new ConversionError(unitsError, 422);

  const variation = lot.packaging_variations;
  const flOz = Number(variation?.total_volume_fl_oz ?? 0);
  if (!(flOz > 0)) throw new ConversionError("That lot's packaging has no volume on record.", 422);
  const containerType = variation?.container?.type ?? null;
  const packagingType: "kegging" | "canning" = containerType === "keg" ? "kegging" : "canning";

  const { data: batchData } = await supabase
    .from("brew_batches")
    .select("id, recipe_id, batch_number")
    .eq("id", lot.batch_id)
    .maybeSingle();
  const batch = batchData as { id: string; recipe_id: string | null; batch_number: string | null } | null;
  if (!batch) throw new ConversionError("That lot's batch no longer exists.", 404);

  // The lot's recipe is the beer in the kegs. It must agree with its batch —
  // the one case it legitimately differs (an in-keg run) books the kegs under
  // the CHILD batch, so a disagreement here is a broken lot, not a feature.
  const sourceRecipeId = lot.recipe_id ?? batch.recipe_id;
  if (!sourceRecipeId) throw new ConversionError("That lot has no recipe — it cannot be converted.", 422);
  if (batch.recipe_id && lot.recipe_id && batch.recipe_id !== lot.recipe_id) {
    throw new ConversionError("That lot's beer does not match its batch. Fix the lot before converting it.", 422);
  }
  if (sourceRecipeId === targetRecipeId) throw new ConversionError("Pick a different beer to convert into.", 422);

  if (!(await isChargeableConversion(supabase, sourceRecipeId, targetRecipeId))) {
    throw new ConversionError(
      "That beer is not a conversion of this lot's recipe. Link it under Recipes → Based On first.",
      422,
    );
  }

  // The same packaging gate a kegging run passes: the container must be
  // declared for the TARGET recipe, or be a generic keg.
  const { data: declaredRows } = await supabase
    .from("recipe_packaging_variations")
    .select("variation_id")
    .eq("recipe_id", targetRecipeId)
    .eq("variation_id", lot.variation_id)
    .limit(1);
  const declared = (declaredRows ?? []).length > 0;
  const genericKeg = containerType === "keg" && !variation?.partner_id && variation?.is_active !== false;
  if (!declared && !genericKeg) {
    throw new ConversionError(
      `${variation?.name ?? "That packaging"} is not declared for the target beer. Add it under Recipes → Packaging Variations first.`,
      422,
    );
  }

  const { data: targetRecipe } = await supabase
    .from("recipes").select("beer_name").eq("id", targetRecipeId).maybeSingle();
  const targetName = (targetRecipe as { beer_name: string | null } | null)?.beer_name ?? "Converted batch";

  const volumeBbl = unitsToBbl(units, flOz);
  if (!(volumeBbl > 0)) throw new ConversionError("Conversion volume must be greater than zero.", 422);

  // ── 1. The child batch ────────────────────────────────────────────────────
  let childBatchId: string | null = null;
  let plannedConversionId: string | null = null;
  const pendingPlan = await findPendingConversionPlan(supabase, { sourceBatchId: lot.batch_id, recipeId: targetRecipeId });
  if (pendingPlan) {
    childBatchId = pendingPlan.targetBatchId;
    plannedConversionId = pendingPlan.planId;
  } else {
    const existing = await findExistingConversionChild(supabase, lot.batch_id, targetRecipeId);
    if (existing) childBatchId = existing.id;
  }

  if (childBatchId) {
    const priorDelivered = await priorConversionInflowBbl(supabase, childBatchId);
    const newVolume = Math.round((priorDelivered + volumeBbl) * 10000) / 10000;
    await supabase.from("brew_batches")
      .update({ volume_bbl: newVolume, converted_volume_bbl: newVolume, converted_from_batch_id: lot.batch_id })
      .eq("id", childBatchId);
    if (plannedConversionId) {
      await supabase.from("batch_conversions")
        .update({ converted_at: new Date().toISOString() })
        .eq("id", plannedConversionId);
    }
  } else {
    childBatchId = await createConversionTargetBatch(supabase, {
      sourceBatchId:  lot.batch_id,
      beerName:       targetName,
      recipeId:       targetRecipeId,
      volumeBbl,
      conversionDate: new Date().toISOString().split("T")[0],
      bornComplete:   true,
    });
  }

  const { data: childRow } = await supabase
    .from("brew_batches").select("batch_number").eq("id", childBatchId).maybeSingle();
  const childNumber = (childRow as { batch_number: string | null } | null)?.batch_number ?? null;

  const unitLabel = `${units} × ${variation?.name ?? "unit"}`;
  const trimmedNote = note?.trim() ? ` — ${note.trim()}` : "";
  const sourceLabel = batch.batch_number ?? lot.batch_id;
  const childLabel = childNumber ?? childBatchId;

  // ── 2. Packaging reversal on the source ───────────────────────────────────
  await recordTransfer(supabase, {
    batchId: lot.batch_id, type: packagingType,
    volumeBbl: -volumeBbl, variationId: lot.variation_id, quantity: -units, createdBy,
    notes: `Converted out of cold storage: ${unitLabel} became ${targetName} (${childLabel})${trimmedNote}`,
  });

  // ── 3. Conversion row on the source ───────────────────────────────────────
  const conversionId = await recordTransfer(supabase, {
    batchId: lot.batch_id, type: "conversion",
    volumeBbl, variationId: lot.variation_id, quantity: units, createdBy,
    notes: `Cold-storage conversion: ${unitLabel} → ${targetName} (${childLabel})${trimmedNote}`,
  });
  await supabase.from("batch_transfers")
    .update({ to_batch_id: childBatchId, packaged_as_recipe_id: targetRecipeId })
    .eq("id", conversionId);

  // ── 4. Packaging row on the child ─────────────────────────────────────────
  const childRunId = await recordTransfer(supabase, {
    batchId: childBatchId, type: packagingType,
    volumeBbl, variationId: lot.variation_id, quantity: units, createdBy,
    notes: `Converted in cold storage from ${sourceLabel}: ${unitLabel}${trimmedNote}`,
  });

  // ── 5. The beer itself ────────────────────────────────────────────────────
  const { error: moveErr } = await supabase.rpc("move_cold_storage_lot_to_batch", {
    p_lot_id:             lotId,
    p_units:              units,
    p_to_batch_id:        childBatchId,
    p_to_recipe_id:       targetRecipeId,
    p_source_transfer_id: childRunId,
  });
  if (moveErr) {
    const stamp = `⚠ Cold storage NOT moved (${unitLabel}): ${moveErr.message}`;
    console.error(`[cold-storage convert] COLD STORAGE NOT MOVED — lot ${lotId} → batch ${childBatchId}:`, moveErr);
    await supabase.from("batch_transfers")
      .update({ notes: stamp })
      .eq("id", childRunId);
    throw new ConversionError(
      `The conversion was recorded on the batches but the cold-storage stock could not be moved (${moveErr.message}). ` +
      `The lot still shows ${unitLabel} under the old beer — fix it by hand before shipping.`,
      500,
    );
  }

  // ── 6. Follow-ups, each best-effort, each logged ──────────────────────────
  try {
    await recordExecutedConversion(supabase, { sourceBatchId: lot.batch_id, targetBatchId: childBatchId, method: "in_package" });
  } catch (e) {
    console.error("[cold-storage convert] Recording executed conversion failed (conversion committed):", e);
  }

  let additions: ConsumeConversionResult["status"] = "not_applicable";
  try {
    const result = await consumeConversionAdditions(supabase, {
      sourceBatchId: lot.batch_id, targetBatchId: childBatchId, volumeBbl, runRef: conversionId,
    });
    additions = result.status;
  } catch (e) {
    console.error("[cold-storage convert] Conversion additions failed (conversion committed):", e);
  }

  try {
    await completeConversionChild(supabase, childBatchId);
  } catch (e) {
    console.error("[cold-storage convert] Child completion failed:", e);
  }

  // The source made less of its own beer than it did a minute ago; its
  // commitments are judged against what it packaged.
  try {
    await recheckBatchCommitments(supabase, lot.batch_id);
  } catch (e) {
    console.error("[cold-storage convert] Source commitment recheck failed:", e);
  }

  await triggerSquarePush(supabase, [sourceRecipeId, targetRecipeId], "cold-storage recipe conversion");

  return {
    childBatchId,
    childBatchNumber: childNumber,
    sourceBatchId: lot.batch_id,
    sourceRecipeId,
    targetRecipeId,
    variationId: lot.variation_id,
    units,
    volumeBbl,
    additions,
  };
}

async function recordTransfer(
  supabase: SupabaseClient,
  { batchId, type, volumeBbl, variationId, quantity, notes, createdBy }: {
    batchId: string;
    type: "kegging" | "canning" | "conversion";
    volumeBbl: number;
    variationId: string;
    quantity: number;
    notes: string;
    createdBy?: string | null;
  },
): Promise<string> {
  const { data, error } = await supabase
    .rpc("record_batch_transfer", {
      p_batch_id:      batchId,
      p_from_tank_id:  null,
      p_to_tank_id:    null,
      p_volume_bbl:    volumeBbl,
      p_shrinkage_bbl: 0,
      p_transfer_type: type,
      p_notes:         notes,
      p_variation_id:  variationId,
      p_quantity:      quantity,
      p_created_by:    createdBy ?? null,
    })
    .single();
  if (error) throw new ConversionError(error.message, 500);
  return (data as { id: string }).id;
}
