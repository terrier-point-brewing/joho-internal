import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * reviseDepositInvoice used to swallow EVERY cancel error — including the one
 * Square raises for a PAID invoice — and then create the replacement anyway,
 * leaving a paid invoice and a fresh draft for the same deposit. It now reads
 * the status first and refuses PAID before anything is created.
 */

const squareGet = vi.fn();
const squarePost = vi.fn();
const squareDelete = vi.fn();

class SquareApiError extends Error {
  constructor(readonly status: number) { super(`square ${status}`); }
}
vi.mock("./client", () => ({
  squareGet: (...a: unknown[]) => squareGet(...a),
  squarePost: (...a: unknown[]) => squarePost(...a),
  squareDelete: (...a: unknown[]) => squareDelete(...a),
  squareLocationId: () => "LOC",
  isSquareNotFound: (e: unknown) => e instanceof SquareApiError && e.status === 404,
}));

import { reviseDepositInvoice, InvoiceStateError } from "./square-invoices";

const params = {
  squareCustomerId: "cust-1",
  title: "Deposit",
  description: "desc",
  depositCents: 5000,
  serviceDate: "2026-10-18",
  dueDate: "2026-10-18",
};

beforeEach(() => {
  vi.clearAllMocks();
  squarePost.mockImplementation(async (path: string) => {
    if (path === "/orders") return { order: { id: "ord-new" } };
    if (path === "/invoices") return { invoice: { id: "inv-new", status: "DRAFT" } };
    return {};
  });
});

describe("reviseDepositInvoice", () => {
  it("refuses a PAID invoice with a 409 state error and creates nothing", async () => {
    squareGet.mockResolvedValue({ invoice: { id: "inv-old", status: "PAID", version: 3 } });
    const err = await reviseDepositInvoice("inv-old", params).catch((e) => e);
    expect(err).toBeInstanceOf(InvoiceStateError);
    expect((err as InvoiceStateError).status).toBe(409);
    expect(squarePost).not.toHaveBeenCalled();
    expect(squareDelete).not.toHaveBeenCalled();
  });

  it("cancels a live DRAFT (Square wants DELETE) and then creates the replacement", async () => {
    squareGet.mockResolvedValue({ invoice: { id: "inv-old", status: "DRAFT", version: 2 } });
    const result = await reviseDepositInvoice("inv-old", params);
    expect(squareDelete).toHaveBeenCalledWith("/invoices/inv-old", { version: "2" });
    expect(result.invoiceId).toBe("inv-new");
  });

  it("leaves an already-CANCELED invoice alone and still creates the replacement", async () => {
    squareGet.mockResolvedValue({ invoice: { id: "inv-old", status: "CANCELED", version: 2 } });
    const result = await reviseDepositInvoice("inv-old", params);
    expect(squareDelete).not.toHaveBeenCalled();
    expect(squarePost.mock.calls.map((c) => c[0])).toEqual(["/orders", "/invoices"]);
    expect(result.invoiceId).toBe("inv-new");
  });

  it("treats a vanished invoice as nothing to cancel", async () => {
    squareGet.mockRejectedValue(new SquareApiError(404));
    const result = await reviseDepositInvoice("inv-gone", params);
    expect(result.invoiceId).toBe("inv-new");
  });

  it("propagates a cancel failure on a live invoice rather than double-billing", async () => {
    squareGet.mockResolvedValue({ invoice: { id: "inv-old", status: "UNPAID", version: 2 } });
    squarePost.mockImplementation(async (path: string) => {
      if (path.endsWith("/cancel")) throw new SquareApiError(409);
      return {};
    });
    await expect(reviseDepositInvoice("inv-old", params)).rejects.toThrow(/square 409/);
    expect(squarePost.mock.calls.map((c) => c[0])).toEqual(["/invoices/inv-old/cancel"]);
  });
});
