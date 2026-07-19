import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Phantom-export alerts: taproom draft-restock keg swaps that booked barrel
 * excise with no cold-storage stock to deduct. Each open alert is an
 * `export_transactions` row with `is_phantom = true` and
 * `alert_acknowledged_at IS NULL`; the daily digest additionally filters on
 * `alert_emailed_at IS NULL`.
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
  tapNumber: number | null;
  variationId: string;
  variationName: string;
  quantityKegs: number;
  volumeBbl: number;
  exciseUsd: number;
  occurredAt: string;
}

export interface EligibleBatch {
  batchId: string;
  batchCode: string;
  onHand: number;
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
  recipes: { beer_name: string } | null;
}

interface RecipeVariationRow {
  variation_id: string;
  packaging_variations: { id: string; container_id: string; format: string | null } | null;
}

interface ColdStorageRow {
  batch_id: string;
  quantity_on_hand: number;
  brew_batches: { batch_number: string } | null;
}

async function fetchPhantomAlerts(
  supabase: SupabaseClient,
  opts: { unemailedOnly: boolean },
): Promise<PhantomAlert[]> {
  let query = supabase
    .from("export_transactions")
    .select(
      "id, recipe_id, packaging_item_id, packaging_format, variant_label, quantity, volume_bbl, total_excise_tax_usd, created_at, recipes(beer_name)",
    )
    .eq("is_phantom", true)
    .is("alert_acknowledged_at", null);
  if (opts.unemailedOnly) query = query.is("alert_emailed_at", null);

  const { data, error } = await query.order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as unknown as PhantomTxRow[];
  const alerts: PhantomAlert[] = [];
  for (const row of rows) {
    const variationId = await resolveVariationId(supabase, row);
    const tapNumber = await resolveTapNumber(supabase, row.recipe_id, variationId);
    alerts.push({
      exportTransactionId: row.id,
      recipeId: row.recipe_id,
      beerName: row.recipes?.beer_name ?? "",
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

/** Resolve the swap packaging variation for a phantom row via its container + format. */
async function resolveVariationId(supabase: SupabaseClient, row: PhantomTxRow): Promise<string> {
  const { data, error } = await supabase
    .from("recipe_packaging_variations")
    .select("variation_id, packaging_variations(id, container_id, format)")
    .eq("recipe_id", row.recipe_id);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as RecipeVariationRow[];
  const match = rows.find(
    (rv) =>
      rv.packaging_variations?.container_id === row.packaging_item_id &&
      rv.packaging_variations?.format === row.packaging_format,
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
 * Cold-storage batches of the alert's recipe + variation that hold enough on
 * hand to reconcile the full swap (targeted single-batch depletion).
 */
export async function fetchEligibleBatches(
  supabase: SupabaseClient,
  alert: PhantomAlert,
): Promise<EligibleBatch[]> {
  const { data, error } = await supabase
    .from("cold_storage_inventory")
    .select("batch_id, quantity_on_hand, brew_batches(batch_number)")
    .eq("recipe_id", alert.recipeId)
    .eq("variation_id", alert.variationId);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as ColdStorageRow[];
  return rows
    .filter((r) => r.quantity_on_hand >= alert.quantityKegs)
    .map((r) => ({
      batchId: r.batch_id,
      batchCode: r.brew_batches?.batch_number ?? "",
      onHand: r.quantity_on_hand,
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
