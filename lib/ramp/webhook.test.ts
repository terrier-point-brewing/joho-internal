import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyRampSignature, isReconcilableRampEvent } from "./webhook";

const SECRET = "ramp-test-webhook-secret";
const BODY = '{"id":"evt_1","type":"transactions.cleared","object":{"id":"txn_1"}}';

const hmac = (secret: string, body: string, enc: "hex" | "base64") =>
  createHmac("sha256", secret).update(body).digest(enc);

describe("verifyRampSignature", () => {
  it("accepts a hex-encoded HMAC-SHA256 of the raw body", () => {
    expect(
      verifyRampSignature({ secret: SECRET, rawBody: BODY, signatureHeader: hmac(SECRET, BODY, "hex") }),
    ).toBe(true);
  });

  it("accepts a base64-encoded HMAC-SHA256 of the raw body", () => {
    expect(
      verifyRampSignature({ secret: SECRET, rawBody: BODY, signatureHeader: hmac(SECRET, BODY, "base64") }),
    ).toBe(true);
  });

  it("tolerates surrounding whitespace on the header", () => {
    expect(
      verifyRampSignature({ secret: SECRET, rawBody: BODY, signatureHeader: `  ${hmac(SECRET, BODY, "hex")}  ` }),
    ).toBe(true);
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(
      verifyRampSignature({ secret: SECRET, rawBody: BODY, signatureHeader: hmac("wrong", BODY, "hex") }),
    ).toBe(false);
  });

  it("rejects a tampered body", () => {
    const forOther = hmac(SECRET, '{"id":"evt_1","type":"transactions.cleared","object":{"id":"txn_9"}}', "hex");
    expect(verifyRampSignature({ secret: SECRET, rawBody: BODY, signatureHeader: forOther })).toBe(false);
  });

  it("rejects a missing secret or signature", () => {
    expect(verifyRampSignature({ secret: "", rawBody: BODY, signatureHeader: hmac(SECRET, BODY, "hex") })).toBe(false);
    expect(verifyRampSignature({ secret: SECRET, rawBody: BODY, signatureHeader: null })).toBe(false);
    expect(verifyRampSignature({ secret: SECRET, rawBody: BODY, signatureHeader: "" })).toBe(false);
  });
});

describe("isReconcilableRampEvent", () => {
  it("is true for transactions.* events", () => {
    expect(isReconcilableRampEvent("transactions.authorized")).toBe(true);
    expect(isReconcilableRampEvent("transactions.cleared")).toBe(true);
    expect(isReconcilableRampEvent("transactions.declined")).toBe(true);
  });

  it("is false for verification, test, and other-resource events", () => {
    expect(isReconcilableRampEvent("webhooks.verification")).toBe(false);
    expect(isReconcilableRampEvent("tests.test_event")).toBe(false);
    expect(isReconcilableRampEvent("bills.paid")).toBe(false);
    expect(isReconcilableRampEvent("reimbursements.ready_for_review")).toBe(false);
    expect(isReconcilableRampEvent(undefined)).toBe(false);
    expect(isReconcilableRampEvent(42)).toBe(false);
  });

  it("treats bill events as reconcilable", () => {
    expect(isReconcilableRampEvent("bill.created")).toBe(true);
    expect(isReconcilableRampEvent("bill.paid")).toBe(true);
  });
  it("still ignores the verification handshake", () => {
    expect(isReconcilableRampEvent("webhooks.verification")).toBe(false);
  });
});
