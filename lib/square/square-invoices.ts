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
    name: string;
    quantity_per_bbl: number;
    cost_per_unit: number;
    unit: string;
    line_total_usd: number;
  }>;
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
  dueDays: number;
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

function addDays(date: Date, days: number): string {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Deposit calculation (pure math, no Square calls) ───────────────────────────

/**
 * Computes the ingredient deposit amount for a given allocation.
 * Formula: sum(ri.quantity_per_bbl × i.cost_per_unit) × batch.volume_bbl × (percentage / 100)
 */
export async function calculateIngredientDeposit(
  supabase: SupabaseClient,
  batchId: string,
  percentage: number
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
  // UNIT CROSSING: ingredient cost math runs in decimal USD dollars (cost_per_unit
  // is a decimal column); Square invoice amounts are integer cents. Round → cents.
  const depositCents = dollarsToCents(depositUsd);

  return {
    total_ingredient_cost_usd: totalIngredientCostUsd,
    deposit_usd: depositUsd,
    deposit_cents: depositCents,
    ingredient_count: breakdown.length,
    breakdown,
  };
}

// ── Generic order+invoice creator ───────────────────────────────────────────────

interface CreateInvoiceCoreParams {
  squareCustomerId: string;
  title: string;
  description?: string;
  lineItems: InvoiceLineItemDraft[];
  /** Exactly one of dueDays or dueDate must be provided. */
  dueDays?: number;
  dueDate?: string;
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
  const { squareCustomerId, title, description, lineItems, dueDays, dueDate, serviceDate, acceptedPaymentMethods, metadataType } = params;
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
  if (dueDays == null && dueDate == null) throw new Error("createInvoice requires either dueDays or dueDate");

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
          due_date: dueDate ?? addDays(new Date(), dueDays!),
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
    acceptedPaymentMethods: { card: true, bank_account: true, cash_app_pay: false, buy_now_pay_later: false },
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
    lineItems: params.lineItems,
    dueDays: params.dueDays,
    // Square requires accepted_payment_methods on any invoice with a payment
    // request. Default to card + bank transfer (ACH), matching the deposit flow.
    acceptedPaymentMethods: { card: true, bank_account: true, cash_app_pay: false, buy_now_pay_later: false },
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
