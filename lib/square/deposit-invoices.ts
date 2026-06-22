/**
 * Allocation Deposit Invoice module.
 *
 * Handles the full lifecycle of Square deposit invoices tied to batch
 * allocations. Deposit invoices charge a partner the expected ingredient
 * cost for their allocation slice, locking in that allocation once paid.
 *
 * This module is intentionally generic so the create/send/cancel/sync
 * primitives can be reused for other invoice scenarios.
 */

import crypto from "crypto";
import { squarePost, squareGet, squareLocationId } from "./client";
import { findIngredientDepositVariationId } from "./catalog";
import type { SupabaseClient } from "@supabase/supabase-js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DepositCalculation {
  /** Total ingredient cost for the entire batch (dollars). */
  total_ingredient_cost_usd: number;
  /** Deposit amount = total_ingredient_cost × (percentage / 100) in dollars. */
  deposit_usd: number;
  /** In cents, ready for Square Money objects. */
  deposit_cents: number;
  ingredient_count: number;
  /** Per-ingredient breakdown for the invoice preview. */
  breakdown: Array<{
    name: string;
    quantity_per_bbl: number;
    cost_per_unit: number;
    unit: string;
    line_total_usd: number;
  }>;
}

export interface CreateDepositInvoiceParams {
  /** Square customer ID for the partner — used as invoice recipient. */
  squareCustomerId: string;
  /** Human-readable label shown on the invoice (e.g. "Bright Lager — 75% allocation"). */
  title: string;
  description: string;
  /** Total deposit amount in cents. */
  depositCents: number;
  /** ISO date string (YYYY-MM-DD) for the invoice service date. */
  serviceDate: string;
  /** ISO date string (YYYY-MM-DD) for the payment due date. */
  dueDate: string;
  /** Optional Square catalog variation ID for the Ingredient Deposit item. */
  depositVariationId?: string | null;
}

export interface DepositInvoiceResult {
  orderId: string;
  invoiceId: string;
  invoiceUrl: string | null;
  squareStatus: string;
}

interface SquareOrderResponse   { order: { id: string } }
interface SquareInvoiceResponse { invoice: { id: string; status: string; public_url?: string; version?: number } }
interface SquareInvoiceGetResponse { invoice: { id: string; status: string; public_url?: string; version: number; updated_at?: string } }
interface SquareOrderTender {
  id: string;
  payment_id?: string;
  amount_money?: { amount: number; currency: string };
}
interface SquareOrderGetResponse {
  order: { id: string; tenders?: SquareOrderTender[] };
}

// ── Deposit calculation ───────────────────────────────────────────────────────

/**
 * Computes the ingredient deposit amount for a given allocation.
 *
 * Formula: sum(ri.quantity_per_bbl × i.cost_per_unit) × batch.volume_bbl × (percentage / 100)
 *
 * Equivalent to: ingredient_cost_per_turn × turns × (percentage / 100)
 */
export async function calculateIngredientDeposit(
  supabase: SupabaseClient,
  batchId: string,
  percentage: number
): Promise<DepositCalculation> {
  // Fetch batch + recipe
  const { data: batch, error: batchErr } = await supabase
    .from("brew_batches")
    .select("id, beer_name, volume_bbl, turns, recipe_id")
    .eq("id", batchId)
    .single();

  if (batchErr || !batch) throw new Error("Batch not found");
  if (!batch.recipe_id) throw new Error("Batch has no recipe — cannot compute ingredient deposit");

  // Fetch recipe ingredients with costs
  const { data: recipeIngredients, error: riErr } = await supabase
    .from("recipe_ingredients")
    .select("quantity_per_bbl, ingredients(id, name, unit, cost_per_unit)")
    .eq("recipe_id", batch.recipe_id);

  if (riErr) throw new Error(`Failed to fetch recipe ingredients: ${riErr.message}`);

  const rows = recipeIngredients ?? [];
  const volumeBbl = Number(batch.volume_bbl);

  let totalIngredientCostUsd = 0;
  const breakdown: DepositCalculation["breakdown"] = [];

  for (const ri of rows) {
    const ing = ri.ingredients as unknown as { id: string; name: string; unit: string; cost_per_unit: number | null } | null;
    if (!ing || ing.cost_per_unit == null) continue;

    const qtyPerBbl = Number(ri.quantity_per_bbl);
    const costPerUnit = Number(ing.cost_per_unit);
    const lineTotal = qtyPerBbl * costPerUnit * volumeBbl;

    totalIngredientCostUsd += lineTotal;
    breakdown.push({
      name: ing.name,
      quantity_per_bbl: qtyPerBbl,
      cost_per_unit: costPerUnit,
      unit: ing.unit,
      line_total_usd: lineTotal,
    });
  }

  const depositUsd = totalIngredientCostUsd * (percentage / 100);
  const depositCents = Math.round(depositUsd * 100);

  return {
    total_ingredient_cost_usd: totalIngredientCostUsd,
    deposit_usd: depositUsd,
    deposit_cents: depositCents,
    ingredient_count: breakdown.length,
    breakdown,
  };
}

// ── Square API operations ─────────────────────────────────────────────────────

/**
 * Creates a draft Square Order + Invoice for a deposit.
 * Does NOT publish (send) the invoice — caller must call publishDepositInvoice.
 */
export async function createDepositInvoice(
  params: CreateDepositInvoiceParams
): Promise<DepositInvoiceResult> {
  const {
    squareCustomerId,
    title,
    description,
    depositCents,
    serviceDate,
    dueDate,
  } = params;

  const loc = squareLocationId();

  // Look up Ingredient Deposit catalog variation if not provided
  const variationId = params.depositVariationId ?? await findIngredientDepositVariationId();

  // Build the order line item — reference catalog variation if found, else custom amount
  const lineItem: Record<string, unknown> = variationId
    ? {
        catalog_object_id: variationId,
        quantity: "1",
        base_price_money: { amount: depositCents, currency: "USD" },
      }
    : {
        name: "Ingredient Deposit",
        quantity: "1",
        item_type: "CUSTOM_AMOUNT",
        base_price_money: { amount: depositCents, currency: "USD" },
      };

  // 1. Create draft Order
  const orderResp = await squarePost<SquareOrderResponse>("/orders", {
    idempotency_key: crypto.randomUUID(),
    order: {
      location_id: loc,
      customer_id: squareCustomerId,
      line_items: [lineItem],
      state: "DRAFT",
      metadata: { source: "tpb-brewing", type: "allocation-deposit" },
    },
  });
  const orderId = orderResp.order.id;

  // 2. Create Invoice against that Order (DRAFT, not yet sent)
  const invoiceResp = await squarePost<SquareInvoiceResponse>("/invoices", {
    idempotency_key: crypto.randomUUID(),
    invoice: {
      location_id: loc,
      order_id: orderId,
      title,
      description,
      sale_or_service_date: serviceDate,
      delivery_method: "EMAIL",
      primary_recipient: { customer_id: squareCustomerId },
      payment_requests: [
        {
          request_type: "BALANCE",
          due_date: dueDate,
          tipping_enabled: false,
        },
      ],
      // Explicitly disable tax — deposit invoices are tax-exempt
      accepted_payment_methods: {
        card: true,
        bank_account: true,
        cash_app_pay: false,
        buy_now_pay_later: false,
      },
    },
  });

  return {
    orderId,
    invoiceId: invoiceResp.invoice.id,
    invoiceUrl: invoiceResp.invoice.public_url ?? null,
    squareStatus: invoiceResp.invoice.status,
  };
}

/**
 * Publishes (sends) a draft Square invoice to the recipient via email.
 * Invoice must be in DRAFT status.
 */
export async function publishDepositInvoice(invoiceId: string): Promise<void> {
  // Fetch current version first — required by Square for publish
  const { invoice } = await squareGet<SquareInvoiceGetResponse>(`/invoices/${invoiceId}`);
  await squarePost(`/invoices/${invoiceId}/publish`, {
    idempotency_key: crypto.randomUUID(),
    version: invoice.version,
  });
}

/**
 * Cancels a Square invoice (must be in DRAFT or UNPAID status).
 * The associated order is also cancelled by Square.
 */
export async function cancelDepositInvoice(invoiceId: string): Promise<void> {
  const { invoice } = await squareGet<SquareInvoiceGetResponse>(`/invoices/${invoiceId}`);
  await squarePost(`/invoices/${invoiceId}/cancel`, { version: invoice.version });
}

/**
 * Replaces an existing deposit invoice with a new one reflecting updated terms.
 * Cancels the old invoice/order and creates a fresh Order + Invoice (DRAFT).
 * Returns the new invoice details — caller must store the new IDs and re-send.
 *
 * Cancel failures (already-cancelled or not-found invoice) are swallowed so
 * a stale ID in the DB doesn't block revision.
 */
export async function reviseDepositInvoice(
  oldInvoiceId: string,
  newParams: CreateDepositInvoiceParams
): Promise<DepositInvoiceResult> {
  try {
    await cancelDepositInvoice(oldInvoiceId);
  } catch {
    // Invoice already cancelled, doesn't exist, or in a non-cancellable state.
    // Proceed to create the replacement regardless.
  }

  return createDepositInvoice(newParams);
}

/**
 * Fetches the current status of a deposit invoice from Square.
 * Returns the Square status string and, when paid, the payment timestamp.
 */
export async function getDepositInvoiceStatus(
  invoiceId: string
): Promise<{ status: string; paidAt: string | null; version: number; publicUrl: string | null }> {
  const { invoice } = await squareGet<SquareInvoiceGetResponse>(`/invoices/${invoiceId}`);

  const isPaid = invoice.status === "PAID";
  return {
    status: invoice.status,
    // Square doesn't surface a paid_at timestamp on the invoice object directly —
    // use updated_at as a proxy when the invoice transitions to PAID.
    paidAt: isPaid ? (invoice.updated_at ?? new Date().toISOString()) : null,
    version: invoice.version,
    publicUrl: invoice.public_url ?? null,
  };
}

/**
 * Fetches the Square Order's payment reference. Square only attaches a
 * `payment_id` to an order's tenders once the order has been paid — this is
 * the only point in the whole flow where Square hands us a payment_id; if
 * it isn't captured here (see the invoice sync route), it isn't recoverable
 * later without a separate Square lookup, which is out of scope for
 * already-paid allocations.
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
