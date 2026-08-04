// lib/production/pendingSquareDeduction.ts
//
// Which recipes is Square still going to decrement by itself?
//
// An absolute push sets Square's count to cold storage's. That is only correct
// when Square has nothing of its own left to subtract. Between shipping stock and
// the invoice that decrements Square for it, Square has EXACTLY that: a decrement
// still owed. Pushing into that window hands the pending deduction a lower
// starting point, and it then takes the same units a second time.
//
//   ship 24 of 100      cold storage 76, Square 100   (Square stale but owed -24)
//   push sets Square 76 cold storage 76, Square  76   (looks right)
//   invoice deducts 24  cold storage 76, Square  52   (wrong, by exactly the ship)
//
// Left alone, Square goes 100 → 76 on its own and lands correct. The push and
// the invoice are two mechanisms for one event; running both double-counts.
//
// THE TEST IS THE MECHANISM, NOT THE CHANNEL. Square can only decrement a
// variation it tracks inventory on, and only when an invoice line actually
// carries that variation. An earlier version of this keyed off a hardcoded
// channel allowlist instead, which duplicated knowledge held in the invoice
// builder: add a channel, or ever put a product line on a contract invoice, and
// it would have silently double-counted. Testing what Square can actually do
// fails the other way — toward a stale count, which the drift view shows and the
// next push fixes.
//
// Once an invoice exists there is no need to predict: its line items say whether
// Square will decrement. Only a shipment with no invoice yet has to be guessed
// at, and there the safe guess is "it will".

export interface ShipmentDeduction {
  recipeId: string;
  /** invoice_required | unpaid | paid */
  status: string;
  invoiceId: string | null;
  /** The shipped item's Square SKU is inventory-tracked, so Square CAN decrement it. */
  skuTracked: boolean;
  /**
   * Whether this shipment's invoice carries any inventory-tracked line.
   * `null` when no invoice exists yet.
   *
   * False is the contract-brewing case: the invoice bills packaging fees, excise
   * and services, so Square will never decrement and the push is the only way it
   * learns the beer left.
   */
  invoiceHasInventoryLine: boolean | null;
}

/**
 * PURE. Recipes with stock that has shipped but whose Square-side deduction has
 * not landed yet.
 */
export function selectPendingDeductionRecipes(rows: ShipmentDeduction[]): Set<string> {
  const pending = new Set<string>();
  for (const r of rows) {
    // Settled: Square has taken its units, or there were never any to take.
    if (r.status === "paid") continue;

    // Square cannot decrement a variation it does not track. Nothing is owed,
    // whatever the invoice ends up saying.
    if (!r.skuTracked) continue;

    // No invoice yet, so nothing to inspect. Assume a deduction is coming —
    // being briefly stale is recoverable, double-counting is the one to avoid.
    if (r.invoiceId === null) { pending.add(r.recipeId); continue; }

    // An invoice exists: believe it rather than guessing from the channel.
    if (r.invoiceHasInventoryLine) pending.add(r.recipeId);
  }
  return pending;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (t: string) => any };

export async function loadPendingDeductionRecipes(db: Db): Promise<Set<string>> {
  const { data: txRows, error: txErr } = await db
    .from("export_transactions")
    .select("recipe_id, variant_label, status, invoice_id")
    .neq("status", "paid");
  if (txErr) throw new Error(txErr.message);

  const shipments = (txRows ?? []) as {
    recipe_id: string | null; variant_label: string | null;
    status: string; invoice_id: string | null;
  }[];
  if (shipments.length === 0) return new Set();

  // Shipped item → its Square SKU, keyed the way the invoice builder resolves it:
  // the literal variation name shipped, scoped to the recipe.
  const { data: linkRows, error: linkErr } = await db
    .from("recipe_square_links")
    .select("recipe_id, square_variation_id, packaging_variations:variation_id ( name )")
    .in("packaging", ["keg", "can"]);
  if (linkErr) throw new Error(linkErr.message);

  const skuByRecipeAndLabel = new Map<string, string>();
  for (const l of (linkRows ?? []) as {
    recipe_id: string; square_variation_id: string; packaging_variations: { name: string | null } | null;
  }[]) {
    const name = l.packaging_variations?.name;
    if (name) skuByRecipeAndLabel.set(`${l.recipe_id}\t${name}`, l.square_variation_id);
  }

  // Which of those SKUs does Square actually track?
  const { data: varRows, error: varErr } = await db
    .from("square_catalog_variations")
    .select("square_variation_id, track_inventory")
    .eq("is_deleted", false);
  if (varErr) throw new Error(varErr.message);

  const trackedSkus = new Set(
    ((varRows ?? []) as { square_variation_id: string; track_inventory: boolean | null }[])
      .filter((v) => v.track_inventory)
      .map((v) => v.square_variation_id),
  );

  // Does each pending invoice carry a line Square would decrement for?
  const invoiceIds = [...new Set(shipments.map((s) => s.invoice_id).filter((x): x is string => !!x))];
  const invoicesWithInventoryLine = new Set<string>();
  if (invoiceIds.length > 0) {
    const { data: liRows, error: liErr } = await db
      .from("invoice_line_items")
      .select("invoice_id, square_catalog_variation_id")
      .in("invoice_id", invoiceIds);
    if (liErr) throw new Error(liErr.message);
    for (const li of (liRows ?? []) as { invoice_id: string; square_catalog_variation_id: string | null }[]) {
      if (li.square_catalog_variation_id && trackedSkus.has(li.square_catalog_variation_id)) {
        invoicesWithInventoryLine.add(li.invoice_id);
      }
    }
  }

  return selectPendingDeductionRecipes(
    shipments
      .filter((s) => s.recipe_id)
      .map((s) => {
        const sku = s.variant_label
          ? skuByRecipeAndLabel.get(`${s.recipe_id}\t${s.variant_label}`)
          : undefined;
        return {
          recipeId: s.recipe_id!,
          status: s.status,
          invoiceId: s.invoice_id,
          skuTracked: !!sku && trackedSkus.has(sku),
          invoiceHasInventoryLine: s.invoice_id ? invoicesWithInventoryLine.has(s.invoice_id) : null,
        };
      }),
  );
}
