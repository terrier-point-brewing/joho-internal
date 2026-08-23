import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a Ramp webhook signature (`X-Ramp-Signature`).
 *
 * Ramp signs each delivery as `HMAC-SHA256(secret, rawBody)`, where `secret` is
 * the `secret` field returned when the subscription is created (used directly as
 * the HMAC key) and only the raw, unparsed request body is signed — no id or
 * timestamp prefix (this is Ramp's own scheme, not Svix).
 *
 * Ramp's docs state the header carries the HMAC-SHA256 hash but don't pin the
 * encoding, so we accept a constant-time match against either the hex or the
 * base64 form. Both are derived from the same keyed HMAC, so accepting whichever
 * encoding Ramp emits weakens nothing — an attacker without the secret can
 * produce neither. Returns true only on an exact match.
 */
export function verifyRampSignature(params: {
  secret: string;
  rawBody: string;
  signatureHeader: string | null;
}): boolean {
  const { secret, rawBody, signatureHeader } = params;
  if (!secret || !signatureHeader) return false;

  const digest = createHmac("sha256", secret).update(rawBody).digest();
  const provided = Buffer.from(signatureHeader.trim());

  // Length check first: timingSafeEqual throws on unequal lengths, and hex (64
  // chars) vs base64 (44 chars) differ, so this routes to the right encoding
  // and leaks nothing.
  for (const encoded of [digest.toString("hex"), digest.toString("base64")]) {
    const expected = Buffer.from(encoded);
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a Ramp webhook event warrants an expense re-sync. Card spend arrives as
 * `transactions.*` events (`transactions.authorized`, `transactions.cleared` —
 * which also fires for refunds/reversals — `transactions.declined`, etc.); bill
 * spend arrives as `bill.*` events (`bill.created`, `bill.paid`, etc.); bank
 * activity arrives as `banking.*` events (e.g. `banking.transaction.created`);
 * out-of-pocket claims arrive as `reimbursements.*` — all four trigger a
 * re-sync. Other resources (users) are acknowledged but skip the sync.
 *
 * `reimbursements.*` was on the skip list until the claims themselves were
 * imported: with nothing reading them, waking the sync for one would have been
 * pure cost. Now a claim IS an expense row, and one that arrives late enough is
 * the difference between a month closing right and closing short.
 *
 * NOT reconcilable: `webhooks.verification` (the endpoint-verification handshake)
 * and `tests.test_event` — the route handles those separately.
 */
export function isReconcilableRampEvent(type: unknown): boolean {
  return typeof type === "string"
    && (type.startsWith("transactions.")
      || type.startsWith("bill.")
      || type.startsWith("banking.")
      || type.startsWith("reimbursements."));
}
