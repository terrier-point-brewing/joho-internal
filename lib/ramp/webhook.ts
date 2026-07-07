import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a Ramp webhook signature. Ramp delivers webhooks via Svix, which signs
 * `base64( HMAC-SHA256(secretBytes, `${svixId}.${svixTimestamp}.${rawBody}`) )`.
 *
 * - `secret` is the Svix signing secret from the Ramp dashboard, in
 *   `whsec_<base64>` form; the bytes after the prefix are base64-decoded to the
 *   HMAC key (Svix signs with the decoded key, not the literal string).
 * - `svixId` / `svixTimestamp` come from the `svix-id` / `svix-timestamp`
 *   headers and are part of the signed content, so a tampered id/timestamp fails.
 * - `signatureHeader` (`svix-signature`) is a space-delimited list of
 *   `v<version>,<base64sig>` entries; we accept if ANY `v1` entry matches in
 *   constant time. Multiple entries appear during secret rotation.
 *
 * Returns true only on an exact match — wrong secret, tampered body, or altered
 * id/timestamp all fail. Replay of a captured-valid delivery still verifies, but
 * the downstream expense sync is idempotent (upsert keyed source_transaction_id),
 * so a replay records nothing new.
 */
export function verifyRampSignature(params: {
  secret: string;
  svixId: string | null;
  svixTimestamp: string | null;
  rawBody: string;
  signatureHeader: string | null;
}): boolean {
  const { secret, svixId, svixTimestamp, rawBody, signatureHeader } = params;
  if (!secret || !svixId || !svixTimestamp || !signatureHeader) return false;

  const rawKey = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const keyBytes = Buffer.from(rawKey, "base64");
  if (keyBytes.length === 0) return false;

  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expected = createHmac("sha256", keyBytes).update(signedContent).digest("base64");
  const expectedBuf = Buffer.from(expected);

  // Header shape: "v1,<sig> v1,<sig> ...". Compare our expected signature against
  // each v1 entry; a match on any one is a pass.
  for (const part of signatureHeader.split(" ")) {
    const comma = part.indexOf(",");
    if (comma === -1) continue;
    if (part.slice(0, comma) !== "v1") continue;
    const sigBuf = Buffer.from(part.slice(comma + 1));
    // Length check first: timingSafeEqual throws on unequal lengths. Base64 HMAC
    // is always 44 chars, so this leaks nothing useful.
    if (sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a Ramp webhook event warrants an expense re-sync. New and updated card
 * spend arrives as `transaction.*` events (e.g. `transaction.created`,
 * `transaction.updated`); other resources (reimbursements, cards, users) are
 * acknowledged but skip the sync. Confirm the exact event names when subscribing
 * in the Ramp dashboard — the prefix match is intentionally defensive.
 */
export function isReconcilableRampEvent(type: unknown): boolean {
  return typeof type === "string" && type.startsWith("transaction");
}
