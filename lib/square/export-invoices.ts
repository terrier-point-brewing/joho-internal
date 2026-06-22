/**
 * Export Transaction Invoice module.
 *
 * Builds multi-line Square orders/invoices for the combined Export
 * Transactions invoicing flow (Packaging Fee / Excise Tax / Keg Cleaning /
 * Forklift line items, with a Bulk Discount catalog discount attached to
 * keg-type Packaging Fee lines). Separate from lib/square/deposit-invoices.ts,
 * which is hardcoded to a single line item and can't represent this shape.
 */

import crypto from "crypto";
import { squarePost, squareGet, squareLocationId } from "./client";
import type { InvoiceLineItemDraft } from "@/lib/production/exportInvoicePreview";

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
}

interface SquareOrderResponse   { order: { id: string } }
interface SquareInvoiceResponse { invoice: { id: string; status: string; public_url?: string; version?: number } }
interface SquareInvoiceGetResponse { invoice: { id: string; status: string; public_url?: string; version: number; updated_at?: string } }

function addDays(date: Date, days: number): string {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function createExportInvoice(
  params: CreateExportInvoiceParams
): Promise<ExportInvoiceResult> {
  const { squareCustomerId, title, lineItems, dueDays } = params;
  const loc = squareLocationId();

  // Discount uid is shared by every line item that references the same
  // discountCatalogId — Square scopes one discount object to N line items
  // via matching discount_uid, not by repeating the discount per line.
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

  // 1. Create draft Order
  const orderResp = await squarePost<SquareOrderResponse>("/orders", {
    idempotency_key: crypto.randomUUID(),
    order: {
      location_id: loc,
      customer_id: squareCustomerId,
      line_items: orderLineItems,
      ...(orderDiscounts.length > 0 ? { discounts: orderDiscounts } : {}),
      state: "DRAFT",
      metadata: { source: "tpb-brewing", type: "export-invoice" },
    },
  });
  const orderId = orderResp.order.id;

  const today = new Date().toISOString().slice(0, 10);

  // 2. Create Invoice against that Order (DRAFT, not yet sent)
  const invoiceResp = await squarePost<SquareInvoiceResponse>("/invoices", {
    idempotency_key: crypto.randomUUID(),
    invoice: {
      location_id: loc,
      order_id: orderId,
      title,
      sale_or_service_date: today,
      delivery_method: "EMAIL",
      primary_recipient: { customer_id: squareCustomerId },
      payment_requests: [
        {
          request_type: "BALANCE",
          due_date: addDays(new Date(), dueDays),
          tipping_enabled: false,
        },
      ],
    },
  });

  // 3. Publish (send) immediately — matches the existing deposit-invoice
  // flow's two-step create-then-publish, collapsed into one call here since
  // there's no separate "review before sending" step in this feature.
  const { invoice: created } = await squareGet<SquareInvoiceGetResponse>(`/invoices/${invoiceResp.invoice.id}`);
  await squarePost(`/invoices/${invoiceResp.invoice.id}/publish`, {
    idempotency_key: crypto.randomUUID(),
    version: created.version,
  });

  return {
    orderId,
    invoiceId: invoiceResp.invoice.id,
    invoiceUrl: invoiceResp.invoice.public_url ?? null,
    squareStatus: "UNPAID",
  };
}

export async function getExportInvoiceStatus(
  invoiceId: string
): Promise<{ status: string; paidAt: string | null; version: number; publicUrl: string | null }> {
  const { invoice } = await squareGet<SquareInvoiceGetResponse>(`/invoices/${invoiceId}`);
  const isPaid = invoice.status === "PAID";
  return {
    status: invoice.status,
    paidAt: isPaid ? (invoice.updated_at ?? new Date().toISOString()) : null,
    version: invoice.version,
    publicUrl: invoice.public_url ?? null,
  };
}
