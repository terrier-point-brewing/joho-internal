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
