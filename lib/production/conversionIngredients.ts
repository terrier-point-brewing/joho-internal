/**
 * What a conversion consumes off the shelf.
 *
 * A conversion draws finished liquid out of a parent batch and turns it into a
 * different beer by adding something — puree, orange peel, coffee. The base
 * recipe's grain is not bought again: it was weighed out and deducted when the
 * parent hit the brewhouse. Only the addition is new stock.
 *
 * Nothing used to deduct it. Ingredient stock leaves the shelf in exactly one
 * place — a brewhouse tank assignment, charging one turn of the recipe — and a
 * conversion-born batch never sees a brewhouse. So the puree was free, and the
 * only way to keep the books from double-charging the base was to leave the
 * derived recipe's bill empty, which is why Orange Pilsner and Blackberry Lemon
 * Wheat still carry no ingredient lines at all.
 *
 * `recipes.base_recipe_id` is what makes the split computable, so this is where
 * the addition finally gets charged.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { baseMapOf, conversionDelta, isDerivedFrom, type BillLine } from "./recipeLineage";
import { releaseCommitments, upsertConversionCommitments } from "./commitments";

/**
 * Note prefix stamped on every stock movement this module writes.
 *
 * Doubles as the idempotency key: the transfers route can be retried, and a
 * second run must not charge the puree twice. A conversion-born batch has no
 * other reason to hold a `batch_use` row, so the presence of one bearing this
 * marker is proof the additions are already booked.
 */
export const CONVERSION_ADDITION_NOTE = "Conversion addition";

/**
 * The lineage map every ancestry question here is answered against.
 *
 * The whole recipes table, which is a few dozen rows — cheaper and far simpler
 * than a recursive query, and it lets the pure walkers in `recipeLineage` do the
 * thinking.
 */
async function fetchBaseMap(supabase: SupabaseClient): Promise<Map<string, string | null>> {
  const { data } = await supabase.from("recipes").select("id, base_recipe_id");
  return baseMapOf((data ?? []) as Array<{ id: string; base_recipe_id: string | null }>);
}

/**
 * True when a conversion from `sourceRecipeId` into `derivedRecipeId` is one the
 * books can price — i.e. the source sits somewhere above the target in the
 * lineage chain.
 *
 * Any depth counts. Transfusion Lager is Carolina Mule plus grape juice and
 * Carolina Mule is Pace Yourself Pilsner plus ginger and lime, so a Transfusion
 * conversion is chargeable off either one; what changes is the subtraction, not
 * whether it is allowed. An unrelated pair is still nothing we can defend
 * charging for.
 */
export async function isChargeableConversion(
  supabase: SupabaseClient,
  sourceRecipeId: string,
  derivedRecipeId: string,
): Promise<boolean> {
  if (sourceRecipeId === derivedRecipeId) return false;
  return isDerivedFrom(derivedRecipeId, sourceRecipeId, await fetchBaseMap(supabase));
}

/**
 * The base recipe a conversion from `sourceBatchId` into `targetBatchId` draws
 * against, or null when the two are unrelated.
 *
 * The base returned is always the SOURCE's own recipe, never whatever the target
 * names in `base_recipe_id`. That is the recipe of the liquid physically being
 * drawn off, so it is the only bill the parent batch actually paid for — and it
 * is what makes a chain work without a special case: draw Transfusion off a Mule
 * batch and the subtraction is against Mule, draw it off a Pilsner batch and the
 * subtraction is against Pilsner.
 */
export async function resolveConversionBase(
  supabase: SupabaseClient,
  sourceBatchId: string,
  targetBatchId: string,
): Promise<{ derivedRecipeId: string; baseRecipeId: string } | null> {
  const [{ data: sourceRow }, { data: targetRow }] = await Promise.all([
    supabase.from("brew_batches").select("recipe_id").eq("id", sourceBatchId).maybeSingle(),
    supabase.from("brew_batches").select("recipe_id").eq("id", targetBatchId).maybeSingle(),
  ]);

  const sourceRecipeId = (sourceRow as { recipe_id: string | null } | null)?.recipe_id ?? null;
  const derivedRecipeId = (targetRow as { recipe_id: string | null } | null)?.recipe_id ?? null;
  if (!sourceRecipeId || !derivedRecipeId) return null;

  const chargeable = await isChargeableConversion(supabase, sourceRecipeId, derivedRecipeId);
  return chargeable ? { derivedRecipeId, baseRecipeId: sourceRecipeId } : null;
}

/**
 * Reserve what a PLANNED conversion will add, so the shortfall warnings fire
 * before the day of the conversion rather than after it.
 *
 * The mirror of a brewed batch's commitments: reserved while the batch sits in
 * planning, released when the stock actually moves. Silent no-op for an unlinked
 * pair — there is nothing to reserve that we can defend.
 */
export async function reserveConversionAdditions(
  supabase: SupabaseClient,
  { sourceBatchId, targetBatchId, volumeBbl }: ConsumeConversionArgs,
): Promise<void> {
  const link = await resolveConversionBase(supabase, sourceBatchId, targetBatchId);
  if (!link) return;
  await upsertConversionCommitments(
    supabase, targetBatchId, link.derivedRecipeId, link.baseRecipeId, volumeBbl,
  );
}

export interface ConsumeConversionArgs {
  sourceBatchId: string;
  targetBatchId: string;
  /** Volume of finished liquid drawn off, in bbl. */
  volumeBbl: number;
}

export type ConsumeConversionResult =
  | { status: "deducted"; lines: Array<{ ingredient_id: string; quantity: number }> }
  | { status: "unlinked" | "no_additions" | "already_booked" | "not_applicable" };

/**
 * Deduct what this conversion adds, and nothing else.
 *
 * Runs only when the target's recipe explicitly declares the source's recipe as
 * its base. Without that declaration there is no way to tell which lines the
 * parent already paid for, and guessing in either direction is worse than
 * leaving the books alone: charge the full bill and the base grain is reserved
 * twice, charge nothing and the addition is free. An unlinked conversion is
 * therefore left exactly as it was — the UI warns about it at the point of
 * conversion, and linking the recipes fixes it going forward.
 *
 * Never throws. A conversion transfer is already committed by the time this
 * runs; a stock write that fails must not roll back the liquid movement, so
 * failures come back as a status for the caller to log.
 */
export async function consumeConversionAdditions(
  supabase: SupabaseClient,
  { sourceBatchId, targetBatchId, volumeBbl }: ConsumeConversionArgs,
): Promise<ConsumeConversionResult> {
  const volume = Number(volumeBbl);
  if (!Number.isFinite(volume) || volume <= 0) return { status: "not_applicable" };

  const link = await resolveConversionBase(supabase, sourceBatchId, targetBatchId);
  if (!link) return { status: "unlinked" };

  const { data: targetRow } = await supabase
    .from("brew_batches").select("batch_number, beer_name").eq("id", targetBatchId).maybeSingle();
  const target = targetRow as { batch_number: string | null; beer_name: string | null } | null;

  const { data: alreadyBooked } = await supabase
    .from("stock_adjustments")
    .select("id")
    .eq("batch_id", targetBatchId)
    .eq("type", "batch_use")
    .like("note", `${CONVERSION_ADDITION_NOTE}%`)
    .limit(1);
  if (alreadyBooked?.length) return { status: "already_booked" };

  const result = await chargeConversionDelta(supabase, {
    derivedRecipeId: link.derivedRecipeId,
    baseRecipeId:    link.baseRecipeId,
    volumeBbl:       volume,
    ledgerBatchId:   targetBatchId,
    note: `${CONVERSION_ADDITION_NOTE} — ${target?.batch_number ?? targetBatchId}: ${target?.beer_name ?? ""}`.trim(),
  });

  // Stock has moved, so whatever this batch was holding in reserve is spent.
  if (result.status === "deducted") await releaseCommitments(supabase, targetBatchId);

  return result;
}

/**
 * Charge an in-keg (or in-can) conversion — one that happens ON the packaging
 * run rather than in a tank.
 *
 * Some conversions never get a vessel of their own: the dose goes into each keg
 * as it is filled, so the beer is Carolina Mule in the brite tank and Transfusion
 * Lager by the time the keg is capped. There is no target batch to hold the
 * addition, because there is no target batch at all — the liquid leaves the
 * source batch as finished goods under a different recipe.
 *
 * So the ledger row hangs off the SOURCE batch (the beer it physically came out
 * of) and is keyed to the packaging transfer, which is what makes it idempotent:
 * a batch can be kegged many times, and each run is its own charge.
 *
 * Never throws — the packaging transfer is already committed by the time this
 * runs, and a stock write that fails must not unmake finished goods.
 */
export async function consumePackagedConversionAdditions(
  supabase: SupabaseClient,
  { sourceBatchId, transferId, packagedRecipeId, volumeBbl }: {
    sourceBatchId: string;
    /** The packaging transfer this charge belongs to — the idempotency key. */
    transferId: string;
    /** The recipe the run actually produced, i.e. what came out of the filler. */
    packagedRecipeId: string;
    /** Finished volume packaged under that recipe, in bbl. */
    volumeBbl: number;
  },
): Promise<ConsumeConversionResult> {
  const volume = Number(volumeBbl);
  if (!Number.isFinite(volume) || volume <= 0) return { status: "not_applicable" };

  const { data: sourceRow } = await supabase
    .from("brew_batches").select("recipe_id, batch_number").eq("id", sourceBatchId).maybeSingle();
  const source = sourceRow as { recipe_id: string | null; batch_number: string | null } | null;
  const baseRecipeId = source?.recipe_id ?? null;
  if (!baseRecipeId) return { status: "unlinked" };
  if (!(await isChargeableConversion(supabase, baseRecipeId, packagedRecipeId))) {
    return { status: "unlinked" };
  }

  // Keyed to the transfer, not the batch: kegging the same batch twice is two
  // conversions and two charges, but retrying one run must not double-charge it.
  const note = `${CONVERSION_ADDITION_NOTE} — ${source?.batch_number ?? sourceBatchId} packaging run ${transferId}`;
  const { data: alreadyBooked } = await supabase
    .from("stock_adjustments")
    .select("id")
    .eq("batch_id", sourceBatchId)
    .eq("type", "batch_use")
    .eq("note", note)
    .limit(1);
  if (alreadyBooked?.length) return { status: "already_booked" };

  return chargeConversionDelta(supabase, {
    derivedRecipeId: packagedRecipeId,
    baseRecipeId,
    volumeBbl:       volume,
    ledgerBatchId:   sourceBatchId,
    note,
  });
}

/**
 * Write the per-bbl difference between two bills to the ingredient ledger.
 *
 * The shared middle of both conversion paths: work out what the derived recipe
 * adds on top of the base, scale it by the volume converted, and move that much
 * stock. Deliberately does no de-duplication of its own — what counts as "the
 * same conversion" differs between a tank conversion (once per target batch) and
 * an in-keg one (once per packaging run), so each caller owns that check.
 */
async function chargeConversionDelta(
  supabase: SupabaseClient,
  { derivedRecipeId, baseRecipeId, volumeBbl, ledgerBatchId, note }: {
    derivedRecipeId: string;
    baseRecipeId: string;
    volumeBbl: number;
    /** Batch the stock movement is filed under. */
    ledgerBatchId: string;
    note: string;
  },
): Promise<ConsumeConversionResult> {
  const [derivedBill, baseBill] = await Promise.all([
    supabase.from("recipe_ingredients")
      .select("ingredient_id, quantity_per_bbl, ingredients(cost_per_unit_usd, unit)")
      .eq("recipe_id", derivedRecipeId),
    supabase.from("recipe_ingredients")
      .select("ingredient_id, quantity_per_bbl")
      .eq("recipe_id", baseRecipeId),
  ]);

  type DerivedLine = BillLine & { ingredients: { cost_per_unit_usd: number | null; unit: string | null } | null };
  const derivedLines = (derivedBill.data ?? []) as unknown as DerivedLine[];
  const delta = conversionDelta(derivedLines, (baseBill.data ?? []) as BillLine[]);

  // A derived recipe that adds nothing — Coffee Epic is still a byte-identical
  // copy of Epic Hazy IPA with the coffee never entered — costs nothing to
  // convert. That is a recipe left unfinished, not a movement to write.
  if (!delta.length) return { status: "no_additions" };

  const metaByIngredient = new Map(
    derivedLines.map((l) => [l.ingredient_id, l.ingredients ?? null]),
  );

  const lines = delta.map((d) => {
    const meta = metaByIngredient.get(d.ingredient_id) ?? null;
    const qty = d.quantity_per_bbl * volumeBbl;
    const costPU = meta?.cost_per_unit_usd ?? null;
    return {
      ingredient_id:          d.ingredient_id,
      quantity:               -qty,
      type:                   "batch_use" as const,
      note,
      batch_id:               ledgerBatchId,
      cost_per_unit_usd:      costPU,
      total_value_change_usd: costPU != null ? -qty * costPU : null,
      unit:                   meta?.unit ?? null,
    };
  });

  // The ledger row goes in first: if the RPC below fails partway, the movement
  // is still on the record and the marker blocks a retry from charging twice.
  const { error: insertErr } = await supabase.from("stock_adjustments").insert(lines);
  if (insertErr) return { status: "not_applicable" };

  for (const line of lines) {
    await supabase.rpc("adjust_ingredient_stock", {
      p_id:    line.ingredient_id,
      p_delta: line.quantity,
    });
  }

  return {
    status: "deducted",
    lines: lines.map((l) => ({ ingredient_id: l.ingredient_id, quantity: -l.quantity })),
  };
}
