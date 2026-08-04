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
// Three shipment models, three answers:
//
//   Taproom               Square deducted at the sale, before the app's row even
//                         existed. Rows are terminal ('paid') at creation and
//                         never reach this rule.
//   Contract brewing      the invoice bills fees/excise/services only, so Square
//                         will NEVER deduct. The ship-time push is the only
//                         signal Square gets — never deferred.
//   Distribution/wholesale the invoice carries the product SKU, so Square will
//                         deduct on its own — at SEND, not at payment. Deferred
//                         from ship until the invoice is sent; the drift in
//                         between is expected and labelled, not corrected.
//
// The decision uses the best evidence available at each stage. Once an invoice
// exists, its actual line items answer directly. Before one exists, the
// shipment's CHANNEL predicts it — not as a proxy but as the cause, since the
// app's own invoice builder branches on channel to decide what the invoice will
// bill. Either way the SKU must be inventory-tracked at all for Square to owe
// anything.

/**
 * Channels whose invoices the app builds WITHOUT product lines — packaging fees,
 * excise, services. No Square deduction will ever arrive for these, so their
 * shipments must be pushed at ship time; deferring them would leave Square
 * offering beer that has physically left, until an invoice that changes nothing.
 *
 * This mirrors the `channel === "contract_brewing"` branch in
 * exportInvoicePreview — the channel is not a proxy for what the invoice will
 * bill, it is what DECIDES it. Used only while no invoice exists; once one does,
 * its actual line items answer instead. A channel not listed here defers, so an
 * unknown or future channel fails toward a stale count rather than a double
 * deduction.
 */
const FEE_ONLY_CHANNELS = new Set(["contract_brewing"]);

export interface ShipmentDeduction {
  recipeId: string;
  /** The shipment's channel — predicts the invoice's shape until one exists. */
  channel: string;
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
    // 'unpaid' means SENT, not merely owed: the send action publishes the Square
    // invoice and flips invoice_required → unpaid in the same request
    // (app/api/production/export/invoice, action=send), and publishing is the
    // moment Square deducts. So by 'unpaid' the deduction has already landed and
    // the recipe is safe to push again — payment changes nothing for inventory.
    // Holding until 'paid' would strand the recipe for the invoice's net terms.
    if (r.status === "unpaid" || r.status === "paid") continue;

    // Square cannot decrement a variation it does not track. Nothing is owed,
    // whatever the invoice ends up saying.
    if (!r.skuTracked) continue;

    // No invoice yet, so nothing to inspect — the channel predicts what the app
    // will build. A fee-only channel gets NO deduction from Square ever, so the
    // ship-time push is the only signal Square gets and must not be held back.
    // Every other channel is assumed to owe one: stale is recoverable,
    // double-counting is not.
    if (r.invoiceId === null) {
      if (!FEE_ONLY_CHANNELS.has(r.channel)) pending.add(r.recipeId);
      continue;
    }

    // An invoice exists: believe its line items rather than the prediction.
    if (r.invoiceHasInventoryLine) pending.add(r.recipeId);
  }
  return pending;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (t: string) => any };

export async function loadPendingDeductionRecipes(db: Db): Promise<Set<string>> {
  const { data: txRows, error: txErr } = await db
    .from("export_transactions")
    .select("recipe_id, variant_label, channel, status, invoice_id")
    .neq("status", "paid");
  if (txErr) throw new Error(txErr.message);

  const shipments = (txRows ?? []) as {
    recipe_id: string | null; variant_label: string | null;
    channel: string; status: string; invoice_id: string | null;
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
          channel: s.channel,
          status: s.status,
          invoiceId: s.invoice_id,
          skuTracked: !!sku && trackedSkus.has(sku),
          invoiceHasInventoryLine: s.invoice_id ? invoicesWithInventoryLine.has(s.invoice_id) : null,
        };
      }),
  );
}
