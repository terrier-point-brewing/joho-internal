import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyRampSignature, isReconcilableRampEvent } from "./webhook";

// Ramp/Svix signs the decoded key bytes, so the test secret is `whsec_` + base64.
const SECRET = "whsec_" + Buffer.from("ramp-test-signing-key").toString("base64");
const ID = "msg_2abc";
const TS = "1720000000";
const BODY = '{"event_type":"transaction.created","data":{"id":"txn_1"}}';

/** Produce a valid `svix-signature` header value for the given parts. */
const sign = (secret: string, id: string, ts: string, body: string) => {
  const keyBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", keyBytes).update(`${id}.${ts}.${body}`).digest("base64");
  return `v1,${sig}`;
};

describe("verifyRampSignature", () => {
  const base = { secret: SECRET, svixId: ID, svixTimestamp: TS, rawBody: BODY };

  it("accepts a signature over `${id}.${timestamp}.${body}`", () => {
    expect(
      verifyRampSignature({ ...base, signatureHeader: sign(SECRET, ID, TS, BODY) }),
    ).toBe(true);
  });

  it("accepts when the header carries multiple space-delimited v1 signatures (rotation)", () => {
    const header = `v1,${"A".repeat(44)} ${sign(SECRET, ID, TS, BODY)}`;
    expect(verifyRampSignature({ ...base, signatureHeader: header })).toBe(true);
  });

  it("rejects a signature made with the wrong secret", () => {
    const wrong = "whsec_" + Buffer.from("nope").toString("base64");
    expect(
      verifyRampSignature({ ...base, signatureHeader: sign(wrong, ID, TS, BODY) }),
    ).toBe(false);
  });

  it("rejects a tampered body", () => {
    const forOther = sign(SECRET, ID, TS, '{"event_type":"transaction.created","data":{"id":"txn_9"}}');
    expect(verifyRampSignature({ ...base, signatureHeader: forOther })).toBe(false);
  });

  it("rejects an altered id or timestamp", () => {
    expect(
      verifyRampSignature({ ...base, svixId: "msg_evil", signatureHeader: sign(SECRET, ID, TS, BODY) }),
    ).toBe(false);
    expect(
      verifyRampSignature({ ...base, svixTimestamp: "1720009999", signatureHeader: sign(SECRET, ID, TS, BODY) }),
    ).toBe(false);
  });

  it("rejects missing secret, headers, or signature", () => {
    const good = sign(SECRET, ID, TS, BODY);
    expect(verifyRampSignature({ ...base, secret: "", signatureHeader: good })).toBe(false);
    expect(verifyRampSignature({ ...base, svixId: null, signatureHeader: good })).toBe(false);
    expect(verifyRampSignature({ ...base, svixTimestamp: null, signatureHeader: good })).toBe(false);
    expect(verifyRampSignature({ ...base, signatureHeader: null })).toBe(false);
    expect(verifyRampSignature({ ...base, signatureHeader: "" })).toBe(false);
  });

  it("ignores non-v1 signature versions", () => {
    const sig = sign(SECRET, ID, TS, BODY).slice("v1,".length);
    expect(verifyRampSignature({ ...base, signatureHeader: `v2,${sig}` })).toBe(false);
  });
});

describe("isReconcilableRampEvent", () => {
  it("is true for transaction.* events", () => {
    expect(isReconcilableRampEvent("transaction.created")).toBe(true);
    expect(isReconcilableRampEvent("transaction.updated")).toBe(true);
  });

  it("is false for non-transaction events and non-strings", () => {
    expect(isReconcilableRampEvent("reimbursement.created")).toBe(false);
    expect(isReconcilableRampEvent("card.updated")).toBe(false);
    expect(isReconcilableRampEvent(undefined)).toBe(false);
    expect(isReconcilableRampEvent(42)).toBe(false);
  });
});
