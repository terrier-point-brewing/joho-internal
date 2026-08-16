// lib/square/createRefund.test.ts
//
// The guard that stands between Square's answer and a credit on our books.
// Returning normally is a promise that the money moved, so the cases that
// matter are the ones where Square says otherwise while still answering 200.
import { describe, it, expect, vi, beforeEach } from "vitest";

const squarePost = vi.fn();

// The arrow keeps the reference lazy: vi.mock is hoisted above the const, so a
// bare `squarePost` in the factory reads it before initialization. Real
// SquareApiError is kept — the decline path branches on it by identity.
vi.mock("./client", async (importActual) => ({
  ...(await importActual<typeof import("./client")>()),
  squarePost: (...args: unknown[]) => squarePost(...args),
}));

import { createRefund, RefundDeclinedError } from "./refunds";
import { SquareApiError } from "./client";

// Braces, not a concise body: mockReset() RETURNS the mock, and vitest treats a
// value returned from beforeEach as a teardown callback -- so it would invoke
// the mock with no arguments after every test, turning a rejecting
// implementation into an unhandled rejection. Same trap as payouts.test.ts.
beforeEach(() => {
  squarePost.mockReset();
});

const ok = (status: string) => ({ refund: { id: "rf_1", status } });

describe("createRefund", () => {
  it("returns the refund when Square completes it", async () => {
    squarePost.mockResolvedValue(ok("COMPLETED"));
    await expect(createRefund("pay_1", 1000, "why")).resolves.toEqual({
      refundId: "rf_1",
      status: "COMPLETED",
    });
  });

  it("accepts PENDING — an ACH refund is never immediately COMPLETED, and rejecting it would leave a real credit unrecorded", async () => {
    squarePost.mockResolvedValue(ok("PENDING"));
    await expect(createRefund("pay_1", 1000, "why")).resolves.toMatchObject({ status: "PENDING" });
  });

  it.each(["FAILED", "REJECTED"])(
    "throws on a 200 carrying terminal status %s, rather than handing back a failure the caller would record as success",
    async (status) => {
      squarePost.mockResolvedValue(ok(status));
      await expect(createRefund("pay_1", 1000, "why")).rejects.toBeInstanceOf(RefundDeclinedError);
    },
  );

  it("names the status in the message so the operator knows what Square said", async () => {
    squarePost.mockResolvedValue(ok("FAILED"));
    await expect(createRefund("pay_1", 1000, "why")).rejects.toThrow(/FAILED/);
  });

  it("converts a rejected request into a decline — nothing moved, so retrying is safe", async () => {
    // mockImplementation, not mockRejectedValue: the latter builds the rejected
    // promise at setup time, which Node flags as unhandled before the test awaits it.
    squarePost.mockImplementation(() =>
      Promise.reject(new SquareApiError(400, "REFUND_AMOUNT_INVALID", "amount too large")),
    );
    const err = await createRefund("pay_1", 1000, "why").catch((e) => e);
    expect(err).toBeInstanceOf(RefundDeclinedError);
    expect(err.code).toBe("REFUND_AMOUNT_INVALID");
    expect(err.message).toContain("amount too large");
  });

  it("rethrows a non-API failure untouched — a dropped connection is ambiguous, not a decline", async () => {
    const boom = new Error("socket hang up");
    squarePost.mockImplementation(() => Promise.reject(boom));
    const err = await createRefund("pay_1", 1000, "why").catch((e) => e);
    expect(err).toBe(boom);
    expect(err).not.toBeInstanceOf(RefundDeclinedError);
  });
});
