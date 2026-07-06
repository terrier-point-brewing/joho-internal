import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifySquareSignature, isReconcilableSquareEvent, extractSquareOrderId } from "./webhook";

const sign = (key: string, url: string, body: string) =>
  createHmac("sha256", key).update(url + body).digest("base64");

const URL_ = "https://app.example.com/api/webhooks/square";
const BODY = '{"type":"order.updated","event_id":"abc"}';
const KEY = "whsec-test-key";

describe("verifySquareSignature", () => {
  it("accepts a signature computed over notificationUrl + rawBody", () => {
    expect(
      verifySquareSignature({ signatureKey: KEY, notificationUrl: URL_, rawBody: BODY, signatureHeader: sign(KEY, URL_, BODY) }),
    ).toBe(true);
  });

  it("rejects a signature made with the wrong key", () => {
    expect(
      verifySquareSignature({ signatureKey: KEY, notificationUrl: URL_, rawBody: BODY, signatureHeader: sign("wrong", URL_, BODY) }),
    ).toBe(false);
  });

  it("rejects a tampered body", () => {
    const forSomeOtherBody = sign(KEY, URL_, '{"type":"order.created"}');
    expect(
      verifySquareSignature({ signatureKey: KEY, notificationUrl: URL_, rawBody: BODY, signatureHeader: forSomeOtherBody }),
    ).toBe(false);
  });

  it("rejects a mismatched notification URL", () => {
    const forOtherUrl = sign(KEY, "https://evil.example.com/hook", BODY);
    expect(
      verifySquareSignature({ signatureKey: KEY, notificationUrl: URL_, rawBody: BODY, signatureHeader: forOtherUrl }),
    ).toBe(false);
  });

  it("rejects when the key or header is missing", () => {
    expect(verifySquareSignature({ signatureKey: "", notificationUrl: URL_, rawBody: BODY, signatureHeader: sign(KEY, URL_, BODY) })).toBe(false);
    expect(verifySquareSignature({ signatureKey: KEY, notificationUrl: URL_, rawBody: BODY, signatureHeader: null })).toBe(false);
    expect(verifySquareSignature({ signatureKey: KEY, notificationUrl: URL_, rawBody: BODY, signatureHeader: "" })).toBe(false);
  });
});

describe("isReconcilableSquareEvent", () => {
  it("is true for order.* events", () => {
    expect(isReconcilableSquareEvent("order.created")).toBe(true);
    expect(isReconcilableSquareEvent("order.updated")).toBe(true);
    expect(isReconcilableSquareEvent("order.fulfillment.updated")).toBe(true);
  });

  it("is false for non-order events and non-strings", () => {
    expect(isReconcilableSquareEvent("payment.updated")).toBe(false);
    expect(isReconcilableSquareEvent("inventory.count.updated")).toBe(false);
    expect(isReconcilableSquareEvent(undefined)).toBe(false);
    expect(isReconcilableSquareEvent(42)).toBe(false);
  });
});

describe("extractSquareOrderId", () => {
  it("reads the order id from data.id (canonical Square shape)", () => {
    const event = {
      type: "order.updated",
      data: {
        type: "order",
        id: "ORDER_ABC123",
        object: { order_updated: { order_id: "ORDER_ABC123", state: "COMPLETED" } },
      },
    };
    expect(extractSquareOrderId(event)).toBe("ORDER_ABC123");
  });

  it("falls back to data.object.order_*.order_id when data.id is absent", () => {
    expect(
      extractSquareOrderId({ data: { object: { order_created: { order_id: "OID_CREATED" } } } }),
    ).toBe("OID_CREATED");
    expect(
      extractSquareOrderId({ data: { object: { order_fulfillment_updated: { order_id: "OID_FULFILL" } } } }),
    ).toBe("OID_FULFILL");
  });

  it("returns null when no order id is present or the shape is unexpected", () => {
    expect(extractSquareOrderId(null)).toBeNull();
    expect(extractSquareOrderId(undefined)).toBeNull();
    expect(extractSquareOrderId({})).toBeNull();
    expect(extractSquareOrderId({ data: {} })).toBeNull();
    expect(extractSquareOrderId({ data: { id: "" } })).toBeNull();
    expect(extractSquareOrderId({ data: { object: { payment_updated: { payment_id: "P1" } } } })).toBeNull();
  });
});
