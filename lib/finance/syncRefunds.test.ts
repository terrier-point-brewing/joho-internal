import { describe, it, expect } from "vitest";
import { normalizeRefund, buildRefundRow, type RefundLike } from "./syncRefunds";

const refund: RefundLike = {
  id: "REFUND_1",
  order_id: "ORDER_9",
  payment_id: "PAY_9",
  amount_money: { amount: 500, currency: "USD" },
  status: "COMPLETED",
  reason: "Customer changed mind",
  created_at: "2026-07-05T12:00:00Z",
  updated_at: "2026-07-05T12:05:00Z",
};

describe("normalizeRefund", () => {
  it("maps a Square refund into our shape, preferring updated_at for the time", () => {
    const n = normalizeRefund(refund);
    expect(n).toMatchObject({
      squareRefundId: "REFUND_1",
      squareOrderId: "ORDER_9",
      squarePaymentId: "PAY_9",
      amountCents: 500,
      currency: "USD",
      status: "COMPLETED",
      reason: "Customer changed mind",
      refundedAt: "2026-07-05T12:05:00Z",
    });
  });

  it("falls back to created_at when updated_at is absent", () => {
    const { updated_at, ...noUpdate } = refund;
    void updated_at;
    expect(normalizeRefund(noUpdate).refundedAt).toBe("2026-07-05T12:00:00Z");
  });

  it("defaults amount to 0 and currency to USD when missing", () => {
    const n = normalizeRefund({ id: "R2" });
    expect(n.amountCents).toBe(0);
    expect(n.currency).toBe("USD");
    expect(n.squareOrderId).toBeNull();
    expect(n.refundedAt).toBeNull();
  });
});

describe("buildRefundRow", () => {
  it("builds the upsert row with linked order db id and contra account", () => {
    const row = buildRefundRow(normalizeRefund(refund), "ORDER_DB_1", "COA_CONTRA");
    expect(row).toMatchObject({
      square_refund_id: "REFUND_1",
      square_order_id: "ORDER_9",
      square_payment_id: "PAY_9",
      order_id: "ORDER_DB_1",
      amount_cents: 500,
      currency: "USD",
      status: "COMPLETED",
      refunded_at: "2026-07-05T12:05:00Z",
      chart_of_accounts_id: "COA_CONTRA",
    });
  });

  it("tolerates an unlinked order and unmapped contra account (nulls)", () => {
    const row = buildRefundRow(normalizeRefund({ id: "R3" }), null, null);
    expect(row.order_id).toBeNull();
    expect(row.chart_of_accounts_id).toBeNull();
    expect(row.square_refund_id).toBe("R3");
  });
});
