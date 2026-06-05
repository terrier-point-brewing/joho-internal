/**
 * Square "Projects" integration.
 *
 * Square's REST API has no native Projects endpoint. The closest analogue is
 * Square Invoices: each invoice has a title, a primary customer, and date fields
 * that map naturally to a brewing batch "project".
 *
 * Creating a Square Invoice requires a Square Order first, so this module:
 *   1. Creates a draft Order (one line item = the batch volume in BBLs)
 *   2. Creates an Invoice against that Order with the batch's name, partner
 *      customer, brew date, and expected delivery date
 *
 * The returned invoice ID is stored in brew_batches.square_invoice_id so the
 * batch can always be linked back to the Square record.
 *
 * DB requirement: run this migration before using this module:
 *   ALTER TABLE brew_batches ADD COLUMN IF NOT EXISTS square_invoice_id text;
 */

import { squarePost } from "./client";
import crypto from "crypto";

function locationId(): string {
  const id = process.env.SQUARE_LOCATION_ID;
  if (!id) throw new Error("SQUARE_LOCATION_ID not set");
  return id;
}

interface CreateSquareProjectParams {
  beerName: string;
  volumeBbl: number;
  plannedBrewDate: string;       // YYYY-MM-DD
  expectedDeliveryDate: string;  // YYYY-MM-DD
  squareCustomerId?: string | null;
}

interface SquareProjectResult {
  orderId: string;
  invoiceId: string;
  invoiceUrl: string | null;
}

interface SquareOrderResponse {
  order: { id: string };
}

interface SquareInvoiceResponse {
  invoice: { id: string; public_url?: string };
}

export async function createSquareProject(
  params: CreateSquareProjectParams
): Promise<SquareProjectResult> {
  const { beerName, volumeBbl, plannedBrewDate, expectedDeliveryDate, squareCustomerId } = params;
  const title = `${beerName} (${volumeBbl} BBLs)`;
  const loc = locationId();
  const idempotencyKey = crypto.randomUUID();

  // 1. Create a draft Square Order
  const orderBody: Record<string, unknown> = {
    idempotency_key: idempotencyKey,
    order: {
      location_id: loc,
      ...(squareCustomerId ? { customer_id: squareCustomerId } : {}),
      line_items: [
        {
          name: title,
          quantity: "1",
          item_type: "CUSTOM_AMOUNT",
          base_price_money: { amount: 0, currency: "USD" },
          note: `Brew batch — ${volumeBbl} BBLs`,
        },
      ],
      state: "DRAFT",
      metadata: {
        source: "tpb-brewing",
        type: "batch-project",
      },
    },
  };

  const orderResp = await squarePost<SquareOrderResponse>("/orders", orderBody);
  const orderId = orderResp.order.id;

  // 2. Create a Square Invoice against that Order
  const invoiceBody: Record<string, unknown> = {
    idempotency_key: crypto.randomUUID(),
    invoice: {
      location_id: loc,
      order_id: orderId,
      title,
      description: `Brewing batch: ${beerName}`,
      sale_or_service_date: plannedBrewDate,
      scheduled_at: new Date(plannedBrewDate).toISOString(),
      delivery_method: "SHARE_MANUALLY",
      ...(squareCustomerId
        ? { primary_recipient: { customer_id: squareCustomerId } }
        : {}),
      payment_requests: [
        {
          request_type: "BALANCE",
          due_date: expectedDeliveryDate,
          tipping_enabled: false,
        },
      ],
      accepted_payment_methods: {
        card: true,
        bank_account: true,
        cash_app_pay: false,
        buy_now_pay_later: false,
      },
    },
  };

  const invoiceResp = await squarePost<SquareInvoiceResponse>("/invoices", invoiceBody);

  return {
    orderId,
    invoiceId: invoiceResp.invoice.id,
    invoiceUrl: invoiceResp.invoice.public_url ?? null,
  };
}

/** Retrieve a Square Invoice by ID. */
export async function getSquareProject(invoiceId: string) {
  interface GetResp { invoice: Record<string, unknown> }
  return squarePost<GetResp>(`/invoices/${invoiceId}`, {});
}

/** Update the title or dates on an existing Square Invoice (requires version). */
export async function updateSquareProject(params: {
  invoiceId: string;
  version: number;
  title?: string;
  expectedDeliveryDate?: string;
}) {
  const { invoiceId, version, title, expectedDeliveryDate } = params;
  const fields: Record<string, unknown> = { version };
  if (title) fields.title = title;

  const paymentRequests = expectedDeliveryDate
    ? [{ request_type: "BALANCE", due_date: expectedDeliveryDate }]
    : undefined;

  interface UpdateResp { invoice: Record<string, unknown> }
  return squarePost<UpdateResp>(`/invoices/${invoiceId}`, {
    idempotency_key: crypto.randomUUID(),
    invoice: { ...fields, ...(paymentRequests ? { payment_requests: paymentRequests } : {}) },
    fields_to_clear: [],
  });
}
