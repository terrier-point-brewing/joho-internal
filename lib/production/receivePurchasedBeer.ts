// lib/production/receivePurchasedBeer.ts
//
// Book beer bought from another brewery (guest beer) into cold storage.
//
// cold_storage_inventory is keyed on a NOT NULL batch_id, so purchased beer
// needs a batch to hang its lot on. It gets ONE placeholder batch per recipe,
// `brew_batches.source = 'purchased'`, found-or-created here. That batch has
// volume_bbl 0 and turns 0 (the derive trigger enforces it), is never listed
// by the batches API, and every export row drawn from it is stamped
// `is_tax_paid_purchase` so it never reaches the excise record. The beer was
// tax-paid by the brewery that made it; we only sell it.
//
// ORDER OF WRITES. Cold storage is written before the receipt journal, in its
// own try/catch, and any error raises — see lib/production/coldStorageUpsert.ts
// for why a silent cold-storage miss is the worst outcome this system has. A
// receipt row that fails AFTER the stock is booked is reported as such: the
// beer is on hand, only the paperwork is missing.

import type { SupabaseClient } from "@supabase/supabase-js";
import { upsertColdStorageInventory } from "@/lib/production/coldStorageUpsert";

export interface ReceivePurchasedBeerArgs {
  recipeId: string;
  variationId: string;
  /** Units received — kegs or cases, whatever the variation is. */
  quantity: number;
  supplier?: string | null;
  /** Total cost of this delivery, in cents. Null when unknown at intake. */
  costCents?: number | null;
  /** YYYY-MM-DD. Defaults to today in the database. */
  receivedOn?: string | null;
  note?: string | null;
  /** Who recorded it. */
  userId?: string | null;
}

export interface ReceivePurchasedBeerResult {
  batchId: string;
  /** True when this call created the recipe's purchased placeholder batch. */
  batchCreated: boolean;
  receiptId: string;
}

export const PURCHASED_BATCH_NOTE =
  "Purchased (guest) beer placeholder. Not brewed here — volume 0, never on the excise record. One per recipe; see beer_receipts for every delivery.";

/**
 * The recipe's purchased placeholder batch, created on first use.
 *
 * `status` is 'complete' from birth: there is nothing to ferment, and the
 * floorplan must never offer it to a tank. `planned_brew_date` is the first
 * receipt date only because the column is NOT NULL.
 */
export async function findOrCreatePurchasedBatch(
  supabase: SupabaseClient,
  recipeId: string,
  receivedOn: string | null | undefined,
): Promise<{ id: string; created: boolean }> {
  const { data: existing, error: readErr } = await supabase
    .from("brew_batches")
    .select("id")
    .eq("recipe_id", recipeId)
    .eq("source", "purchased")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (readErr) throw new Error(`Could not look up the purchased-beer batch for this recipe: ${readErr.message}`);
  if (existing) return { id: existing.id, created: false };

  const { data: created, error: insErr } = await supabase
    .from("brew_batches")
    .insert({
      recipe_id: recipeId,
      source: "purchased",
      status: "complete",
      planned_brew_date: receivedOn ?? new Date().toISOString().slice(0, 10),
      volume_bbl: 0,
      turns: 0,
      notes: PURCHASED_BATCH_NOTE,
    })
    .select("id")
    .single();
  if (insErr || !created) {
    throw new Error(`Could not create the purchased-beer batch for this recipe: ${insErr?.message ?? "no row returned"}`);
  }
  return { id: created.id, created: true };
}

/**
 * The same rule TransferModal applies at packaging time: a variation is valid
 * for a recipe if it is declared in recipe_packaging_variations, or if it is a
 * generic (no partner) keg. Cans have no generic fallback — a can SKU is a
 * specific label on a specific beer. The modal filters its list the same way;
 * this is the server's copy so a hand-built request can't put Hop Roar into a
 * Vienna Lager can.
 */
export async function assertVariationAllowedForRecipe(
  supabase: SupabaseClient,
  recipeId: string,
  variationId: string,
): Promise<void> {
  const { data: link, error: linkErr } = await supabase
    .from("recipe_packaging_variations")
    .select("id")
    .eq("recipe_id", recipeId)
    .eq("variation_id", variationId)
    .maybeSingle();
  if (linkErr) throw new Error(`Could not check the recipe's packaging: ${linkErr.message}`);
  if (link) return;

  const { data: variation, error: varErr } = await supabase
    .from("packaging_variations")
    .select("id, is_active, partner_id, container:packaging_items!packaging_variations_container_id_fkey(type)")
    .eq("id", variationId)
    .maybeSingle();
  if (varErr) throw new Error(`Could not read the packaging variation: ${varErr.message}`);
  if (!variation) throw new Error("That packaging variation does not exist");

  const container = variation.container as unknown as { type: string } | { type: string }[] | null;
  const containerType = Array.isArray(container) ? container[0]?.type : container?.type;
  const genericKeg = variation.is_active && variation.partner_id == null && containerType === "keg";
  if (!genericKeg) {
    throw new Error("That packaging is not declared for this beer. Add it under the recipe's packaging first.");
  }
}

export async function receivePurchasedBeer(
  supabase: SupabaseClient,
  args: ReceivePurchasedBeerArgs,
): Promise<ReceivePurchasedBeerResult> {
  const { recipeId, variationId, quantity } = args;
  if (!recipeId) throw new Error("recipeId is required");
  if (!variationId) throw new Error("variationId is required");
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("quantity must be a positive number");
  if (args.costCents != null && (!Number.isInteger(args.costCents) || args.costCents < 0)) {
    throw new Error("costCents must be a whole, non-negative number of cents");
  }

  await assertVariationAllowedForRecipe(supabase, recipeId, variationId);

  const batch = await findOrCreatePurchasedBatch(supabase, recipeId, args.receivedOn);

  // Cold storage FIRST, and loudly. This is the write that makes the beer
  // exist for Export Bay, Configure Taps and the taproom grid.
  try {
    await upsertColdStorageInventory(supabase, {
      batchId: batch.id,
      recipeId,
      variationId,
      quantityDelta: quantity,
      sourceTransferId: null,
    });
  } catch (err) {
    throw new Error(
      `COLD STORAGE NOT BOOKED — ${quantity} unit(s) of purchased beer were not added to the cold room: ${(err as Error).message}`,
    );
  }

  const { data: receipt, error: receiptErr } = await supabase
    .from("beer_receipts")
    .insert({
      batch_id: batch.id,
      recipe_id: recipeId,
      variation_id: variationId,
      quantity,
      supplier: args.supplier?.trim() || null,
      cost_cents: args.costCents ?? null,
      received_on: args.receivedOn ?? undefined,
      note: args.note?.trim() || null,
      created_by: args.userId ?? null,
    })
    .select("id")
    .single();
  if (receiptErr || !receipt) {
    throw new Error(
      `The beer IS in cold storage (${quantity} unit(s) booked) but the receipt could not be recorded: ${receiptErr?.message ?? "no row returned"}`,
    );
  }

  return { batchId: batch.id, batchCreated: batch.created, receiptId: receipt.id };
}
