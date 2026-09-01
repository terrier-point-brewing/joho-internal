/**
 * Square Invoice module — shared by the deposit-invoice flow (batch
 * allocations) and the export-transaction invoice flow. A single generic
 * order+invoice creator (`createInvoice`) backs both; `createDepositInvoice`
 * and `createExportInvoice` are thin, domain-named wrappers so existing
 * call sites keep their original parameter shapes.
 */

import crypto from "crypto";
import { squarePost, squareGet, squareDelete, squareLocationId } from "./client";
import { dollarsToCents } from "@/lib/money";
import type { InvoiceLineItemDraft } from "@/lib/production/exportInvoicePreview";
import type { SupabaseClient } from "@supabase/supabase-js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DepositCalculation {
  total_ingredient_cost_usd: number;
  deposit_usd: number;
  deposit_cents: number;
  ingredient_count: number;
  breakdown: Array<{
    ingredient_id: string;
    name: string;
    quantity_per_bbl: number;
    cost_per_unit_usd: number;
    unit: string;
    line_total_usd: number;
  }>;
  /**
   * Recipes whose bill was netted out of this calculation, in the order asked
   * for. Empty on an ordinary full-bill deposit. See `IngredientDepositOptions`.
   */
  excluded_recipe_ids: string[];
}

export interface IngredientDepositOptions {
  /**
   * Ancestor recipes whose ingredients this deposit must NOT charge for.
   *
   * A conversion recipe carries the COMPLETE bill — Transfusion Pilsner lists
   * the Pilsner's grain, the Mule's ginger and lime, and its own grape juice —
   * because brewing it from scratch is legitimate and every costing reader
   * needs the whole thing. But when the beer was actually made by converting,
   * the base's grain was bought and charged once already, against the batch it
   * was drawn off. Charging it again on the conversion's deposit bills the
   * partner twice for the same malt.
   *
   * Excluding a recipe subtracts ITS per-bbl rates from the bill being priced,
   * ingredient by ingredient, floored at zero — a conversion can only add, so a
   * base that uses more of something than the derived recipe nets to nothing
   * rather than a credit.
   *
   * Several may be excluded at once, and the chain makes that meaningful:
   * Pilsner → Carolina Mule → Transfusion Pilsner. Excluding the Pilsner alone
   * charges ginger + lime + grape juice; excluding the Pilsner AND the Mule
   * charges only the grape juice. Because bills nest, the union is taken as the
   * HIGHEST rate any excluded recipe carries for an ingredient, which gives
   * exactly those two answers without depending on the order they arrive in.
   */
  excludeRecipeIds?: string[];
}

export interface CreateDepositInvoiceParams {
  squareCustomerId: string;
  title: string;
  description: string;
  depositCents: number;
  serviceDate: string;
  dueDate: string;
  depositVariationId?: string | null;
}

export interface DepositInvoiceResult {
  orderId: string;
  invoiceId: string;
  invoiceUrl: string | null;
  squareStatus: string;
  invoiceNumber: string | null;
}

export interface CreateExportInvoiceParams {
  squareCustomerId: string;
  title: string;
  lineItems: InvoiceLineItemDraft[];
  dueDate: string;
  /**
   * Customer-visible note, rendered by Square on the invoice itself and in the
   * email that carries it. Use it to say the thing the line items cannot — that
   * this invoice is late and why, that a shipment was re-billed to a different
   * partner, that a credit is coming. Omitted, the invoice reads exactly as
   * before.
   */
  description?: string;
}

export interface ExportInvoiceResult {
  orderId: string;
  invoiceId: string;
  invoiceUrl: string | null;
  squareStatus: string;
  invoiceNumber: string | null;
}

interface SquareOrderResponse   { order: { id: string } }
interface SquareInvoiceResponse { invoice: { id: string; status: string; public_url?: string; version?: number; invoice_number?: string } }
interface SquareInvoiceGetResponse { invoice: { id: string; status: string; public_url?: string; version: number; updated_at?: string; invoice_number?: string } }
interface SquareOrderTender {
  id: string;
  payment_id?: string;
  amount_money?: { amount: number; currency: string };
}
interface SquareOrderGetResponse {
  order: { id: string; tenders?: SquareOrderTender[] };
}

// ── Deposit calculation (pure math, no Square calls) ───────────────────────────

/**
 * Computes the ingredient deposit amount for a given allocation.
 * Formula: sum(ri.quantity_per_turn × turns × i.cost_per_unit_usd) × (percentage / 100)
 *
 * Priced off the per-turn bill as entered, not the derived quantity_per_bbl
 * rate: that rate divides the bill by expected_yield_bbl, so multiplying it by
 * batch volume billed the partner for grain nobody bought. The per-bbl figure
 * on each breakdown line is a display rate over the turn's own volume, so
 * rate × volume still reconciles to the line total.
 *
 * `options.excludeRecipeIds` nets an ancestor recipe's bill out first, for a
 * batch that was made by converting rather than brewed from scratch — see
 * IngredientDepositOptions. Omitted, the whole bill is priced, exactly as before.
 */
export async function calculateIngredientDeposit(
  supabase: SupabaseClient,
  batchId: string,
  percentage: number,
  options?: IngredientDepositOptions
): Promise<DepositCalculation> {
  const { data: batch, error: batchErr } = await supabase
    .from("brew_batches")
    .select("id, beer_name, volume_bbl, turns, recipe_id")
    .eq("id", batchId)
    .single();

  if (batchErr || !batch) throw new Error("Batch not found");
  if (!batch.recipe_id) throw new Error("Batch has no recipe — cannot compute ingredient deposit");

  const { data: recipeIngredients, error: riErr } = await supabase
    .from("recipe_ingredients")
    .select("quantity_per_turn, ingredients(id, name, unit, cost_per_unit_usd)")
    .eq("recipe_id", batch.recipe_id);

  if (riErr) throw new Error(`Failed to fetch recipe ingredients: ${riErr.message}`);

  const rows = recipeIngredients ?? [];
  const volumeBbl = Number(batch.volume_bbl);
  const turns = Math.max(1, Number(batch.turns ?? 1));
  // Volume of one turn — the denominator that makes the displayed per-bbl rate
  // multiply back to the line total. Guarded so a volume-less batch can't
  // divide by zero and emit Infinity into an invoice.
  const turnVol = volumeBbl > 0 ? volumeBbl / turns : 0;

  // ── What an excluded base already paid for, expressed in THIS bill's terms ──
  // The excluded rates are per bbl (that is the only figure two recipes with
  // different expected yields share); the bill being priced is per turn. turnVol
  // is the bridge, so a volume-less batch cannot express the subtraction at all
  // — better to refuse than to silently charge the full bill under a label that
  // says otherwise.
  const excludeRecipeIds = [...new Set(options?.excludeRecipeIds ?? [])].filter(
    (id) => id && id !== batch.recipe_id,
  );
  const excludedPerTurn = new Map<string, number>();
  if (excludeRecipeIds.length > 0) {
    if (turnVol <= 0) {
      throw new Error(
        "This batch has no recorded volume, so a converted-from recipe's ingredients cannot be netted out of its deposit.",
      );
    }
    const { data: baseRows, error: baseErr } = await supabase
      .from("recipe_ingredients")
      .select("recipe_id, ingredient_id, quantity_per_bbl")
      .in("recipe_id", excludeRecipeIds);
    if (baseErr) throw new Error(`Failed to fetch converted-from recipe ingredients: ${baseErr.message}`);

    // Sum within a recipe (a bill may list an ingredient on more than one line),
    // then take the highest across recipes — the union, since the chain nests.
    const perRecipe = new Map<string, Map<string, number>>();
    for (const row of baseRows ?? []) {
      const qty = Number(row.quantity_per_bbl);
      if (!Number.isFinite(qty)) continue;
      const byIngredient = perRecipe.get(row.recipe_id as string) ?? new Map<string, number>();
      byIngredient.set(row.ingredient_id as string, (byIngredient.get(row.ingredient_id as string) ?? 0) + qty);
      perRecipe.set(row.recipe_id as string, byIngredient);
    }
    for (const byIngredient of perRecipe.values()) {
      for (const [ingredientId, qtyPerBbl] of byIngredient) {
        excludedPerTurn.set(
          ingredientId,
          Math.max(excludedPerTurn.get(ingredientId) ?? 0, qtyPerBbl * turnVol),
        );
      }
    }
  }

  let totalIngredientCostUsd = 0;
  const breakdown: DepositCalculation["breakdown"] = [];

  for (const ri of rows) {
    const ing = ri.ingredients as unknown as { id: string; name: string; unit: string; cost_per_unit_usd: number | null } | null;
    if (!ing || ing.cost_per_unit_usd == null) continue;

    const grossPerTurn = Number(ri.quantity_per_turn);
    // Drawn down as it is consumed, so a bill listing an ingredient twice has
    // the exclusion applied once across both lines rather than once per line.
    const claimable = Math.min(grossPerTurn, excludedPerTurn.get(ing.id) ?? 0);
    if (claimable > 0) excludedPerTurn.set(ing.id, (excludedPerTurn.get(ing.id) ?? 0) - claimable);
    const qtyPerTurn = grossPerTurn - claimable;
    // An ingredient the base fully covers adds nothing to a conversion-only
    // deposit, so it is dropped rather than shown as a $0 line.
    if (excludeRecipeIds.length > 0 && qtyPerTurn <= 0) continue;

    const costPerUnit = Number(ing.cost_per_unit_usd);
    const lineTotal = qtyPerTurn * turns * costPerUnit;
    const qtyPerBbl = turnVol > 0 ? qtyPerTurn / turnVol : 0;

    totalIngredientCostUsd += lineTotal;
    breakdown.push({
      ingredient_id: ing.id,
      name: ing.name,
      quantity_per_bbl: qtyPerBbl,
      cost_per_unit_usd: costPerUnit,
      unit: ing.unit,
      line_total_usd: lineTotal,
    });
  }

  const depositUsd = totalIngredientCostUsd * (percentage / 100);
  // UNIT CROSSING: ingredient cost math runs in decimal USD dollars (cost_per_unit_usd
  // is a decimal column); Square invoice amounts are integer cents. Round → cents.
  const depositCents = dollarsToCents(depositUsd);

  return {
    total_ingredient_cost_usd: totalIngredientCostUsd,
    deposit_usd: depositUsd,
    deposit_cents: depositCents,
    ingredient_count: breakdown.length,
    breakdown,
    excluded_recipe_ids: excludeRecipeIds,
  };
}

// ── Generic order+invoice creator ───────────────────────────────────────────────

interface CreateInvoiceCoreParams {
  squareCustomerId: string;
  title: string;
  description?: string;
  lineItems: InvoiceLineItemDraft[];
  /** Due date for the invoice's BALANCE payment request (YYYY-MM-DD). */
  dueDate: string;
  /** Defaults to today (YYYY-MM-DD) if omitted. */
  serviceDate?: string;
  acceptedPaymentMethods?: { card: boolean; bank_account: boolean; cash_app_pay: boolean; buy_now_pay_later: boolean };
  metadataType: "allocation-deposit" | "export-invoice";
}

/**
 * Creates a draft Square Order + Invoice (DRAFT status, never published —
 * publishing is always a separate, explicit `send` action in both flows).
 */
async function createInvoice(params: CreateInvoiceCoreParams): Promise<{ orderId: string; invoiceId: string; invoiceUrl: string | null; squareStatus: string; invoiceNumber: string | null }> {
  const { squareCustomerId, title, description, lineItems, dueDate, serviceDate, acceptedPaymentMethods, metadataType } = params;
  const loc = squareLocationId();

  const discountUidByCatalogId = new Map<string, string>();
  for (const li of lineItems) {
    if (li.discountCatalogId && !discountUidByCatalogId.has(li.discountCatalogId)) {
      discountUidByCatalogId.set(li.discountCatalogId, crypto.randomUUID());
    }
  }

  const orderLineItems = lineItems.map((li) => {
    const uid = crypto.randomUUID();
    const base: Record<string, unknown> = li.squareCatalogVariationId
      ? {
          uid,
          catalog_object_id: li.squareCatalogVariationId,
          quantity: String(li.quantity),
          base_price_money: { amount: li.unitPriceCents, currency: "USD" },
          // For catalog lines the name comes from Square's catalog, so surface the
          // user-entered description as the line item's note instead of losing it.
          ...(li.description ? { note: li.description } : {}),
        }
      : {
          uid,
          name: li.description,
          quantity: String(li.quantity),
          item_type: "CUSTOM_AMOUNT",
          base_price_money: { amount: li.unitPriceCents, currency: "USD" },
        };
    if (li.discountCatalogId) {
      const discountUid = discountUidByCatalogId.get(li.discountCatalogId)!;
      base.applied_discounts = [{ discount_uid: discountUid }];
    }
    return base;
  });

  const orderDiscounts = [...discountUidByCatalogId.entries()].map(([catalogId, uid]) => ({
    uid,
    catalog_object_id: catalogId,
    scope: "LINE_ITEM",
  }));

  const orderResp = await squarePost<SquareOrderResponse>("/orders", {
    idempotency_key: crypto.randomUUID(),
    order: {
      location_id: loc,
      customer_id: squareCustomerId,
      line_items: orderLineItems,
      ...(orderDiscounts.length > 0 ? { discounts: orderDiscounts } : {}),
      state: "OPEN",
      metadata: { source: "tpb-brewing", type: metadataType },
    },
  });
  const orderId = orderResp.order.id;

  const today = new Date().toISOString().slice(0, 10);

  const invoiceResp = await squarePost<SquareInvoiceResponse>("/invoices", {
    idempotency_key: crypto.randomUUID(),
    invoice: {
      location_id: loc,
      order_id: orderId,
      title,
      ...(description ? { description } : {}),
      sale_or_service_date: serviceDate ?? today,
      delivery_method: "EMAIL",
      primary_recipient: { customer_id: squareCustomerId },
      payment_requests: [
        {
          request_type: "BALANCE",
          due_date: dueDate,
          tipping_enabled: false,
        },
      ],
      ...(acceptedPaymentMethods ? { accepted_payment_methods: acceptedPaymentMethods } : {}),
    },
  });

  return {
    orderId,
    invoiceId: invoiceResp.invoice.id,
    invoiceUrl: invoiceResp.invoice.public_url ?? null,
    squareStatus: invoiceResp.invoice.status,
    invoiceNumber: invoiceResp.invoice.invoice_number ?? null,
  };
}

// ── Deposit invoice wrapper ──────────────────────────────────────────────────

export async function createDepositInvoice(
  params: CreateDepositInvoiceParams
): Promise<DepositInvoiceResult> {
  const lineItems: InvoiceLineItemDraft[] = [{
    id: "deposit",
    description: "Ingredient Deposit",
    quantity: 1,
    unitPriceCents: params.depositCents,
    squareCatalogVariationId: params.depositVariationId ?? null,
  }];

  return createInvoice({
    squareCustomerId: params.squareCustomerId,
    title: params.title,
    description: params.description,
    lineItems,
    dueDate: params.dueDate,
    serviceDate: params.serviceDate,
    // ACH-only: TPB does not accept card payments on generated invoices.
    acceptedPaymentMethods: { card: false, bank_account: true, cash_app_pay: false, buy_now_pay_later: false },
    metadataType: "allocation-deposit",
  });
}

/**
 * Replaces an existing deposit invoice with a new one reflecting updated terms.
 * Cancel failures (already-cancelled or not-found invoice) are swallowed so
 * a stale ID in the DB doesn't block revision.
 */
export async function reviseDepositInvoice(
  oldInvoiceId: string,
  newParams: CreateDepositInvoiceParams
): Promise<DepositInvoiceResult> {
  try {
    await cancelInvoice(oldInvoiceId);
  } catch {
    // Invoice already cancelled, doesn't exist, or in a non-cancellable state.
  }
  return createDepositInvoice(newParams);
}

// ── Export invoice wrapper ───────────────────────────────────────────────────

export async function createExportInvoice(
  params: CreateExportInvoiceParams
): Promise<ExportInvoiceResult> {
  return createInvoice({
    squareCustomerId: params.squareCustomerId,
    title: params.title,
    description: params.description,
    lineItems: params.lineItems,
    dueDate: params.dueDate,
    // ACH-only: TPB does not accept card payments on generated invoices.
    acceptedPaymentMethods: { card: false, bank_account: true, cash_app_pay: false, buy_now_pay_later: false },
    metadataType: "export-invoice",
  });
}

// ── Shared generic operations ────────────────────────────────────────────────

/** Publishes (sends) a draft Square invoice to the recipient via email. */
export async function publishInvoice(invoiceId: string): Promise<void> {
  const { invoice } = await squareGet<SquareInvoiceGetResponse>(`/invoices/${invoiceId}`);
  await squarePost(`/invoices/${invoiceId}/publish`, {
    idempotency_key: crypto.randomUUID(),
    version: invoice.version,
  });
}

/** Cancels or deletes a Square invoice depending on its current status.
 *  Square requires DELETE for DRAFT invoices and POST /cancel for published ones. */
export async function cancelInvoice(invoiceId: string): Promise<void> {
  const { invoice } = await squareGet<SquareInvoiceGetResponse>(`/invoices/${invoiceId}`);
  if (invoice.status === "DRAFT") {
    await squareDelete(`/invoices/${invoiceId}`, { version: String(invoice.version) });
  } else {
    await squarePost(`/invoices/${invoiceId}/cancel`, { version: invoice.version });
  }
}

/** Fetches the current status of an invoice from Square. */
export async function getInvoiceStatus(
  invoiceId: string
): Promise<{ status: string; paidAt: string | null; updatedAt: string | null; version: number; publicUrl: string | null; invoiceNumber: string | null }> {
  const { invoice } = await squareGet<SquareInvoiceGetResponse>(`/invoices/${invoiceId}`);
  const isPaid = invoice.status === "PAID";
  return {
    status: invoice.status,
    paidAt: isPaid ? (invoice.updated_at ?? new Date().toISOString()) : null,
    updatedAt: invoice.updated_at ?? null,
    version: invoice.version,
    publicUrl: invoice.public_url ?? null,
    invoiceNumber: invoice.invoice_number ?? null,
  };
}

/**
 * Fetches the Square Order's payment reference. Square only attaches a
 * `payment_id` to an order's tenders once the order has been paid.
 */
export async function getOrderPayment(
  orderId: string
): Promise<{ paymentId: string | null; amountPaidCents: number | null }> {
  const { order } = await squareGet<SquareOrderGetResponse>(`/orders/${orderId}`);
  const tender = order.tenders?.[0];
  return {
    paymentId: tender?.payment_id ?? null,
    amountPaidCents: tender?.amount_money?.amount ?? null,
  };
}
