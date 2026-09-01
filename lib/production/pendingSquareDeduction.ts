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
//   ship 24 of 100       cold storage 76  IN_STOCK 100  committed  0
//   invoice raised/sent  cold storage 76  IN_STOCK 100  committed 24
//   push sets IN_STOCK   cold storage 76  IN_STOCK  76  committed 24  (looks right)
//   payment deducts 24   cold storage 76  IN_STOCK  52  committed  0  (wrong, by the ship)
//
// Left alone, Square goes 100 → 76 on its own at payment and lands correct. The
// push and the invoice are two mechanisms for one event; running both
// double-counts. Note the third row only LOOKS right: Square's AVAILABLE is
// IN_STOCK minus committed, so the push has already taken it to 52 there.
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
//                         deduct on its own — at PAYMENT. Raising the invoice
//                         only COMMITS the units; they stay in IN_STOCK until it
//                         is paid. Deferred from ship all the way to payment; the
//                         drift in between is expected and labelled, not
//                         corrected.
//
// ── Corrected 2026-09-01 ─────────────────────────────────────────────────────
//
// This file used to release a shipment at 'unpaid' (sent), asserting that
// "publishing is the moment Square deducts". That is wrong. Square holds an
// invoice's units as COMMITTED when the invoice is raised and moves them out of
// IN_STOCK only on payment — which is exactly why an unpaid invoice shows an
// oversell warning instead of reading as already sold. Releasing at send let the
// push write IN_STOCK down to cold storage while the commitment was still
// outstanding, so payment took the same units twice and Square under-reported
// until the next absolute push cleaned up.
//
// Waiting for payment costs nothing: the commitment already holds Square's
// AVAILABLE equal to cold storage for the whole window.
//
// The decision uses the best evidence available at each stage. Once an invoice
// exists, its actual line items answer directly. Before one exists, the
// shipment's CHANNEL predicts it — not as a proxy but as the cause, since the
// app's own invoice builder branches on channel to decide what the invoice will
// bill. Either way the SKU must be inventory-tracked at all for Square to owe
// anything.

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

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

/** Why a recipe is being held back, in the terms an operator can act on. */
export type PendingHoldReason =
  /** Invoice raised and sent; Square holds the units COMMITTED and deducts at payment. */
  | "awaiting_payment"
  /** Shipped, no invoice yet. Raising one is what starts Square's deduction. */
  | "awaiting_invoice";

export interface PendingHold {
  recipeId: string;
  reason: PendingHoldReason;
  /** Invoices behind the hold. Empty for `awaiting_invoice`. */
  invoiceIds: string[];
}

/**
 * PURE. Recipes with stock that has shipped but whose Square-side deduction has
 * not landed yet, and why.
 *
 * A recipe can be held by several shipments at once. `awaiting_payment` wins the
 * label when both apply, because it is the one with a named invoice an operator
 * can go and chase.
 */
export function selectPendingDeductionHolds(rows: ShipmentDeduction[]): PendingHold[] {
  const byRecipe = new Map<string, { reason: PendingHoldReason; invoiceIds: Set<string> }>();

  const hold = (recipeId: string, reason: PendingHoldReason, invoiceId: string | null) => {
    const existing = byRecipe.get(recipeId);
    if (!existing) {
      byRecipe.set(recipeId, {
        reason,
        invoiceIds: new Set(invoiceId ? [invoiceId] : []),
      });
      return;
    }
    if (invoiceId) existing.invoiceIds.add(invoiceId);
    if (reason === "awaiting_payment") existing.reason = "awaiting_payment";
  };

  for (const r of rows) {
    // PAID is the only release. Square holds an invoice's units as COMMITTED
    // from the moment the invoice is raised and does not move them out of
    // IN_STOCK until it is paid — which is why an unpaid invoice shows an
    // oversell warning rather than simply reading as sold.
    //
    // This used to release at 'unpaid' (i.e. sent), on the belief that
    // publishing was the moment Square deducted. It is not. Releasing then let
    // the push set IN_STOCK down to cold storage while the commitment was still
    // outstanding, and payment then took the same units a second time:
    //
    //   ship 24 of 100     cold storage 76  IN_STOCK 100  committed  0
    //   invoice raised     cold storage 76  IN_STOCK 100  committed 24  (available 76 ✓)
    //   push (was here)    cold storage 76  IN_STOCK  76  committed 24  (available 52 ✗)
    //   payment            cold storage 76  IN_STOCK  52  committed  0  (✗ by the ship)
    //
    // Held to payment, rows three and four collapse into one correct move.
    // Nothing is lost by waiting: Square's own commitment already keeps
    // AVAILABLE equal to cold storage for the whole window, so the taproom can
    // never sell the shipped units even while IN_STOCK still counts them.
    if (r.status === "paid") continue;

    // An invoice exists: its line items are the best evidence there is, and they
    // are checked FIRST — before the skuTracked gate — because skuTracked rests
    // on resolving the shipped item's name to a SKU, and a failed resolution
    // must not release a shipment whose drafted invoice provably carries an
    // inventory line Square will deduct.
    if (r.invoiceId !== null) {
      if (r.invoiceHasInventoryLine) {
        // 'unpaid' means the invoice is sent and the commitment is live;
        // 'invoice_required' means it is still a draft. Either way Square has
        // not deducted, but only the sent one is waiting on the customer.
        hold(r.recipeId, r.status === "unpaid" ? "awaiting_payment" : "awaiting_invoice", r.invoiceId);
      }
      continue;
    }

    // No invoice yet, so predict. Square cannot decrement a variation it does
    // not track, so an untracked (or unmapped — the invoice builder cannot put
    // an unmapped item on a product invoice either) SKU owes nothing.
    if (!r.skuTracked) continue;

    // The channel predicts what the app will build. A fee-only channel gets NO
    // deduction from Square ever, so the ship-time push is the only signal
    // Square gets and must not be held back. Every other channel is assumed to
    // owe one: stale is recoverable, double-counting is not.
    if (!FEE_ONLY_CHANNELS.has(r.channel)) hold(r.recipeId, "awaiting_invoice", null);
  }

  return [...byRecipe.entries()].map(([recipeId, v]) => ({
    recipeId, reason: v.reason, invoiceIds: [...v.invoiceIds],
  }));
}

/** PURE. The same decision, as the id set the push gate consumes. */
export function selectPendingDeductionRecipes(rows: ShipmentDeduction[]): Set<string> {
  return new Set(selectPendingDeductionHolds(rows).map((h) => h.recipeId));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (t: string) => any };

export async function loadPendingDeductionRecipes(db: Db): Promise<Set<string>> {
  return new Set((await loadPendingDeductionHolds(db)).map((h) => h.recipeId));
}

/** The same load, keeping WHY each recipe is held so the drift view can say so. */
export async function loadPendingDeductionHolds(db: Db): Promise<PendingHold[]> {
  const { data: txRows, error: txErr } = await db
    .from("export_transactions")
    .select("recipe_id, variant_label, channel, status, invoice_id")
    .neq("status", "paid");
  if (txErr) throw new Error(txErr.message);

  const shipments = (txRows ?? []) as {
    recipe_id: string | null; variant_label: string | null;
    channel: string; status: string; invoice_id: string | null;
  }[];
  if (shipments.length === 0) return [];

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

  return selectPendingDeductionHolds(
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

// ── Committed stock, from our own open invoices ──────────────────────────────

/**
 * Units Square is holding COMMITTED against invoices we have raised and not been
 * paid for, keyed by Square variation id.
 *
 * Read from OUR invoices rather than from Square. Square keeps committed stock in
 * an inventory state `fetchCurrentCounts` does not request — it asks for IN_STOCK
 * only — and guessing that state name in order to write against it would be
 * careless. We already know what is committed: it is exactly the
 * inventory-tracked lines of every unpaid invoice. Corroborated against the
 * Square dashboard on 2026-09-01, where invoice 000054's 20 x 1/6 Keg and 8 x 1/2
 * Keg of Epic Hazy matched the committed figures exactly.
 *
 * Fee lines — packaging, barrel excise, keg cleaning, forklift, materials,
 * ingredient deposits — carry track_inventory=false and commit nothing, which is
 * why a contract-brewing invoice contributes zero here.
 *
 * ADMIN CLIENT, deliberately. `invoice_line_items` is gated by the RLS policy
 * `get_my_role() = ANY (finance_reader_roles())`, and finance_reader_roles()
 * returns an EMPTY array, so NO user session can read it — the query comes back
 * empty with no error. Through a request-scoped client this would silently report
 * nothing committed and the compensation would quietly not happen, which is the
 * failure mode that makes a wrong number look like a right one. `invoices` is
 * admin-only for the same reason.
 */
export async function loadCommittedBySquareSku(): Promise<Map<string, number>> {
  const admin = createSupabaseAdminClient();
  const out = new Map<string, number>();

  const { data: invRows, error: invErr } = await admin
    .from("invoices")
    .select("id")
    .not("status", "in", "(paid,voided,cancelled)");
  if (invErr) throw new Error(`committed: invoices unreadable — ${invErr.message}`);
  const openIds = (invRows ?? []).map((r) => r.id as string);
  if (openIds.length === 0) return out;

  const [liRes, varRes] = await Promise.all([
    admin.from("invoice_line_items")
      .select("square_catalog_variation_id, quantity")
      .in("invoice_id", openIds)
      .not("square_catalog_variation_id", "is", null),
    admin.from("square_catalog_variations")
      .select("square_variation_id, track_inventory")
      .eq("is_deleted", false),
  ]);
  if (liRes.error) throw new Error(`committed: invoice lines unreadable — ${liRes.error.message}`);
  if (varRes.error) throw new Error(`committed: catalog unreadable — ${varRes.error.message}`);

  const tracked = new Set(
    ((varRes.data ?? []) as { square_variation_id: string; track_inventory: boolean | null }[])
      .filter((v) => v.track_inventory)
      .map((v) => v.square_variation_id),
  );

  for (const li of (liRes.data ?? []) as { square_catalog_variation_id: string; quantity: number | string }[]) {
    // Square holds nothing against an untracked SKU, so a fee line commits nothing.
    if (!tracked.has(li.square_catalog_variation_id)) continue;
    const qty = Number(li.quantity) || 0;
    if (qty <= 0) continue;
    out.set(li.square_catalog_variation_id, (out.get(li.square_catalog_variation_id) ?? 0) + qty);
  }
  return out;
}
