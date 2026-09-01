/**
 * The customer-visible note on an export invoice.
 *
 * Square renders `Invoice.description` on the invoice itself and in the email
 * that carries it, so this is the one field on the generate path that speaks to
 * the recipient. These tests pin that it reaches Square when given, and that an
 * invoice raised without one goes out exactly as it did before the field
 * existed — an empty `description` key would print a blank note block.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const squarePost = vi.fn();

vi.mock("./client", () => ({
  squarePost: (path: string, body: unknown) => squarePost(path, body),
  squareGet: vi.fn(),
  squareDelete: vi.fn(),
  squareLocationId: () => "LOC1",
}));

import { createExportInvoice } from "./square-invoices";

const LINE_ITEMS = [
  { id: "l1", description: "1/6 Keg", quantity: 2, unitPriceCents: 12000, squareCatalogVariationId: null },
];

function invoiceBody(): Record<string, unknown> {
  const call = squarePost.mock.calls.find(([path]) => path === "/invoices");
  if (!call) throw new Error("no /invoices call");
  return (call[1] as { invoice: Record<string, unknown> }).invoice;
}

describe("createExportInvoice — note to the customer", () => {
  beforeEach(() => {
    squarePost.mockReset();
    squarePost.mockImplementation(async (path: string) =>
      path === "/orders"
        ? { order: { id: "ORDER1" } }
        : { invoice: { id: "INV1", status: "DRAFT", version: 0 } }
    );
  });

  it("carries the note onto the Square invoice as its description", async () => {
    await createExportInvoice({
      squareCustomerId: "CUST1",
      title: "Export Invoice — Fortnight Brewing",
      lineItems: LINE_ITEMS,
      dueDate: "2026-09-30",
      description: "Shipped July 20 — we missed the invoice, apologies for the late bill.",
    });

    expect(invoiceBody().description).toBe(
      "Shipped July 20 — we missed the invoice, apologies for the late bill."
    );
  });

  it("omits the field entirely when no note is given", async () => {
    await createExportInvoice({
      squareCustomerId: "CUST1",
      title: "Export Invoice — Fortnight Brewing",
      lineItems: LINE_ITEMS,
      dueDate: "2026-09-30",
    });

    expect(invoiceBody()).not.toHaveProperty("description");
  });

  it("omits the field for an empty note rather than sending a blank description", async () => {
    await createExportInvoice({
      squareCustomerId: "CUST1",
      title: "Export Invoice — Fortnight Brewing",
      lineItems: LINE_ITEMS,
      dueDate: "2026-09-30",
      description: "",
    });

    expect(invoiceBody()).not.toHaveProperty("description");
  });
});
