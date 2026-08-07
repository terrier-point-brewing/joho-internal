import { SupabaseClient } from "@supabase/supabase-js";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";
import type { PhantomOrigin } from "@/lib/production/writePhantomExport";

/**
 * Phantom-export alerts: taproom bookings that carried barrel excise with no
 * cold-storage stock to deduct. Each open alert is an `export_transactions` row
 * with `is_phantom = true` and `alert_acknowledged_at IS NULL`; the daily digest
 * additionally filters on `alert_emailed_at IS NULL`.
 *
 * NOT all of these are draft swaps, and this module used to assume they were.
 * `recordTaproomConsumption` books draft swaps, keg sales and can sales through
 * one path, so a wholesale keg sale that outran cold storage produced a phantom
 * indistinguishable from a keg drained off a tap — and was then listed as a
 * "draft swap" with a tap number attached to it. `phantom_origin` (see the
 * 20260930090000 migration) carries the kind, and `origin` on the alert exposes
 * it so each kind can be presented and reconciled on its own terms. A tap
 * number is resolved for draft swaps only; nothing else drains a tap.
 *
 * `export_transactions` does not store `variation_id` (see
 * `exportInvoicePreview.ts`'s buildProductLines for the established
 * precedent), so an alert's `variationId` is resolved from
 * `recipe_packaging_variations` → `packaging_variations` on
 * (recipe_id, container_id = packaging_item_id, format = packaging_format).
 * `tapNumber` is resolved from `tap_assignments` on
 * (recipe_id, swap_variation_id). `variationName` rides directly on
 * `export_transactions.variant_label`.
 */

export interface PhantomAlert {
  exportTransactionId: string;
  recipeId: string;
  beerName: string;
  /**
   * Which consumption kind booked this row. Null only on a legacy row the
   * backfill could not resolve to a container; treated as unclassified rather
   * than silently folded into draft swaps.
   */
  origin: PhantomOrigin | null;
  /** Draft swaps only — a sale drains no tap. */
  tapNumber: number | null;
  variationId: string;
  variationName: string;
  quantityKegs: number;
  volumeBbl: number;
  exciseUsd: number;
  occurredAt: string;
}

export interface EligibleLot {
  variationId: string;
  variationName: string;
  batchId: string;
  batchCode: string;
  onHand: number;
}

/** Max per-keg volume gap (fl oz) for a lot to count as the "same size" as a
 *  booked swap. Keg sizes (661 / 992 / 1984 fl oz) are far enough apart that a
 *  few fl oz of rounding never bleeds across sizes. */
export const SWAP_VOLUME_TOLERANCE_FL_OZ = 5;

/** Per-keg volume (fl oz) a phantom booked: total BBL / keg count × fl oz per BBL. */
export function swapPerKegFlOz(volumeBbl: number, quantityKegs: number): number {
  return quantityKegs > 0 ? (volumeBbl / quantityKegs) * BBL_TO_FL_OZ : 0;
}

interface PhantomTxRow {
  id: string;
  recipe_id: string;
  packaging_item_id: string;
  packaging_format: string | null;
  variant_label: string;
  quantity: number;
  volume_bbl: number;
  total_excise_tax_usd: number;
  created_at: string;
  phantom_origin: PhantomOrigin | null;
  recipes: { beer_name: string } | null;
}

interface RecipeVariationRow {
  variation_id: string;
  packaging_variations: { id: string; container_id: string; format: string | null } | null;
}

interface ColdStorageLotRow {
  batch_id: string;
  variation_id: string;
  quantity_on_hand: number;
  brew_batches: { batch_number: string } | null;
  packaging_variations: {
    name: string;
    total_volume_fl_oz: number | null;
    container: { type: string } | null;
  } | null;
}

async function fetchPhantomAlerts(
  supabase: SupabaseClient,
  opts: { unemailedOnly: boolean },
): Promise<PhantomAlert[]> {
  let query = supabase
    .from("export_transactions")
    .select(
      "id, recipe_id, packaging_item_id, packaging_format, variant_label, quantity, volume_bbl, total_excise_tax_usd, created_at, phantom_origin, recipes(beer_name)",
    )
    .eq("is_phantom", true)
    .is("alert_acknowledged_at", null);
  if (opts.unemailedOnly) query = query.is("alert_emailed_at", null);

  const { data, error } = await query.order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as unknown as PhantomTxRow[];
  const alerts: PhantomAlert[] = [];
  for (const row of rows) {
    const variationId = await resolveSwapVariationId(supabase, {
      recipeId: row.recipe_id,
      containerId: row.packaging_item_id,
      format: row.packaging_format,
    });
    // A tap number only means something for a swap. Resolving it for a sale
    // invented an association — the lookup matches on (recipe, swap variation),
    // so any keg sale of a beer that happens to be on tap picked up that tap's
    // number and read as if the tap had been drained.
    const tapNumber =
      row.phantom_origin === "draft_swap"
        ? await resolveTapNumber(supabase, row.recipe_id, variationId)
        : null;
    alerts.push({
      exportTransactionId: row.id,
      recipeId: row.recipe_id,
      beerName: row.recipes?.beer_name ?? "",
      origin: row.phantom_origin,
      tapNumber,
      variationId,
      variationName: row.variant_label,
      quantityKegs: row.quantity,
      volumeBbl: row.volume_bbl,
      exciseUsd: row.total_excise_tax_usd,
      occurredAt: row.created_at,
    });
  }
  return alerts;
}

/**
 * Resolve the swap packaging variation for a phantom row via its container +
 * format. `export_transactions` stores no `variation_id`, so it is derived
 * from `recipe_packaging_variations` on (recipe_id, container_id, format).
 * Shared by the alert list and the reconcile path. Returns "" when unresolved.
 */
export async function resolveSwapVariationId(
  supabase: SupabaseClient,
  { recipeId, containerId, format }: { recipeId: string; containerId: string; format: string | null },
): Promise<string> {
  const { data, error } = await supabase
    .from("recipe_packaging_variations")
    .select("variation_id, packaging_variations(id, container_id, format)")
    .eq("recipe_id", recipeId);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as RecipeVariationRow[];
  const match = rows.find(
    (rv) => rv.packaging_variations?.container_id === containerId && rv.packaging_variations?.format === format,
  );
  return match?.variation_id ?? "";
}

/** Resolve the tap this swap variation drains, or null if not assigned to a tap. */
async function resolveTapNumber(
  supabase: SupabaseClient,
  recipeId: string,
  variationId: string,
): Promise<number | null> {
  if (!variationId) return null;
  const { data, error } = await supabase
    .from("tap_assignments")
    .select("tap_number")
    .eq("recipe_id", recipeId)
    .eq("swap_variation_id", variationId);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as { tap_number: number | null }[];
  return rows.length > 0 ? rows[0].tap_number ?? null : null;
}

/** Open, unacknowledged phantom alerts (the in-app list). */
export async function fetchOpenPhantomAlerts(supabase: SupabaseClient): Promise<PhantomAlert[]> {
  return fetchPhantomAlerts(supabase, { unemailedOnly: false });
}

/** Open, unacknowledged AND not-yet-emailed phantom alerts (the daily digest). */
export async function fetchUnemailedPhantomAlerts(supabase: SupabaseClient): Promise<PhantomAlert[]> {
  return fetchPhantomAlerts(supabase, { unemailedOnly: true });
}

/**
 * Cold-storage lots (variation + batch) of the alert's recipe that can resolve
 * the swap: a keg container, the SAME per-keg volume the phantom booked (so
 * excise/volume stay valid — never recomputed), and enough on hand for the full
 * swap. Unlike the old batch-only view this offers *every* same-size keg
 * variation the recipe holds, so a mislinked booked variation is still
 * resolvable against the keg physically drained.
 */
export async function fetchEligibleLots(
  supabase: SupabaseClient,
  alert: PhantomAlert,
): Promise<EligibleLot[]> {
  const { data, error } = await supabase
    .from("cold_storage_inventory")
    .select(
      "batch_id, variation_id, quantity_on_hand, brew_batches(batch_number), packaging_variations(name, total_volume_fl_oz, container:packaging_items!packaging_variations_container_id_fkey(type))",
    )
    .eq("recipe_id", alert.recipeId);
  if (error) throw new Error(error.message);
  const perKeg = swapPerKegFlOz(alert.volumeBbl, alert.quantityKegs);
  const rows = (data ?? []) as unknown as ColdStorageLotRow[];
  return rows
    .filter((r) => r.packaging_variations?.container?.type === "keg")
    .filter(
      (r) =>
        r.packaging_variations?.total_volume_fl_oz != null &&
        Math.abs(Number(r.packaging_variations.total_volume_fl_oz) - perKeg) <= SWAP_VOLUME_TOLERANCE_FL_OZ,
    )
    .filter((r) => Number(r.quantity_on_hand) >= alert.quantityKegs)
    .map((r) => ({
      variationId: r.variation_id,
      variationName: r.packaging_variations?.name ?? "",
      batchId: r.batch_id,
      batchCode: r.brew_batches?.batch_number ?? "",
      onHand: Number(r.quantity_on_hand),
    }));
}

/** Stamp `alert_emailed_at` on the given phantom export rows (digest dedupe). */
export async function markPhantomAlertsEmailed(
  supabase: SupabaseClient,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase
    .from("export_transactions")
    .update({ alert_emailed_at: new Date().toISOString() })
    .in("id", ids);
  if (error) throw new Error(error.message);
}
