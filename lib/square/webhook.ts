import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a Square webhook signature (`x-square-hmacsha256-signature`).
 *
 * Square signs `base64( HMAC-SHA256(signatureKey, notificationUrl + rawBody) )`,
 * where `notificationUrl` is the exact URL configured in the Square dashboard and
 * `rawBody` is the unparsed request body. Returns true only on an exact,
 * constant-time match — a wrong key, tampered body, or mismatched URL all fail.
 */
export function verifySquareSignature(params: {
  signatureKey: string;
  notificationUrl: string;
  rawBody: string;
  signatureHeader: string | null;
}): boolean {
  const { signatureKey, notificationUrl, rawBody, signatureHeader } = params;
  if (!signatureKey || !signatureHeader) return false;

  const expected = createHmac("sha256", signatureKey)
    .update(notificationUrl + rawBody)
    .digest("base64");

  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  // Length check first: timingSafeEqual throws on unequal lengths. Base64 HMAC is
  // always 44 chars, so this leaks nothing useful.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Whether a Square event type warrants a taproom-consumption reconcile. A Draft
 * Restock is a completed order line item, so only `order.*` events matter; other
 * event types are acknowledged but skip the sync.
 */
export function isReconcilableSquareEvent(type: unknown): boolean {
  return typeof type === "string" && type.startsWith("order.");
}

/**
 * Whether a Square event type should drive a finance sync. Orders cover new
 * sales and cancellations (state → CANCELED); refunds cover money returned
 * (which never changes order state, so it needs its own event). Decoupled from
 * the taproom gate so the two consumers evolve independently.
 */
export function isFinanceSyncableEvent(type: unknown): boolean {
  return typeof type === "string" && (type.startsWith("order.") || type.startsWith("refund."));
}

/** Whether an event type is a refund event (`refund.created` / `refund.updated`). */
export function isRefundEvent(type: unknown): boolean {
  return typeof type === "string" && type.startsWith("refund.");
}

/**
 * Pull the refund object out of a `refund.*` webhook event. Square nests it at
 * `data.object.refund` with `order_id` / `payment_id` / `amount_money` / status.
 * NOTE: for refund events `data.id` is the REFUND id, not an order id — so
 * `extractSquareOrderId` must not be used to find the order here. Returns null
 * if the payload isn't a well-formed refund event.
 */
export function extractSquareRefund(event: unknown): {
  id: string;
  order_id?: string;
  payment_id?: string;
  amount_money?: { amount?: number; currency?: string };
  status?: string;
  reason?: string;
  created_at?: string;
  updated_at?: string;
} | null {
  if (!event || typeof event !== "object") return null;
  const data = (event as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const obj = (data as { object?: unknown }).object;
  if (!obj || typeof obj !== "object") return null;
  const refund = (obj as { refund?: unknown }).refund;
  if (!refund || typeof refund !== "object") return null;
  const id = (refund as { id?: unknown }).id;
  if (typeof id !== "string" || !id) return null;
  return refund as ReturnType<typeof extractSquareRefund> & object;
}

/**
 * Pull the affected order id out of a Square `order.*` webhook event so we can
 * refetch and sync just that order. Square puts it at `data.id`; we also fall
 * back to the `data.object.order_*.order_id` shapes for resilience. Returns null
 * if no order id is present (a non-order event or an unexpected payload).
 */
export function extractSquareOrderId(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const data = (event as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;

  const id = (data as { id?: unknown }).id;
  if (typeof id === "string" && id) return id;

  const obj = (data as { object?: unknown }).object;
  if (obj && typeof obj === "object") {
    for (const key of ["order_updated", "order_created", "order_fulfillment_updated"]) {
      const inner = (obj as Record<string, unknown>)[key];
      if (inner && typeof inner === "object") {
        const orderId = (inner as { order_id?: unknown }).order_id;
        if (typeof orderId === "string" && orderId) return orderId;
      }
    }
  }
  return null;
}

/** Whether an event type is a Square invoice event (`invoice.*`). */
export function isInvoiceEvent(type: unknown): boolean {
  return typeof type === "string" && type.startsWith("invoice.");
}

/**
 * Pull the affected invoice id out of a Square `invoice.*` webhook event so we
 * can refetch and reconcile just that invoice. Square nests it at
 * `data.object.invoice.id`; we fall back to `data.id`. Returns null if no
 * invoice id is present (a non-invoice event or unexpected payload).
 */
export function extractSquareInvoiceId(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const data = (event as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;

  const obj = (data as { object?: unknown }).object;
  if (obj && typeof obj === "object") {
    const invoice = (obj as { invoice?: unknown }).invoice;
    if (invoice && typeof invoice === "object") {
      const id = (invoice as { id?: unknown }).id;
      if (typeof id === "string" && id) return id;
    }
  }

  const dataId = (data as { id?: unknown }).id;
  if (typeof dataId === "string" && dataId) return dataId;

  return null;
}
