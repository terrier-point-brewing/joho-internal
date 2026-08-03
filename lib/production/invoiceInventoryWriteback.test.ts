import { describe, it, expect } from "vitest";
import { planInvoiceWriteback, writebackSourceRef, type InvoiceBeerLine } from "./invoiceInventoryWriteback";
import { INVOICE_WRITEBACK_ENABLED } from "@/lib/square/pushGate";

function line(over: Partial<InvoiceBeerLine> = {}): InvoiceBeerLine {
  return {
    invoiceId: "INV-1",
    lineItemId: "LI-1",
    invoiceType: "standard",
    status: "paid",
    hasExportTransactions: false,
    squareVariationId: "SQ-KEG",
    quantity: 4,
    recipeId: "R1",
    variationId: "PV-HALF",
    partnerId: "P1",
    channel: null,
    ...over,
  };
}

const none = new Set<string>();

describe("planInvoiceWriteback", () => {
  it("books a paid Square-raised invoice the Export Bay never shipped", () => {
    const plan = planInvoiceWriteback({ lines: [line()], alreadyBookedRefs: none });
    expect(plan.writes).toEqual([
      expect.objectContaining({
        invoiceId: "INV-1",
        sourceRef: "sqinvoice:INV-1:LI-1",
        recipeId: "R1",
        variationId: "PV-HALF",
        quantity: 4,
        channel: "distribution",
      }),
    ]);
  });

  // Square only decrements at payment. Draining cold storage for an unpaid
  // invoice would take stock that is still on the shelf and may never sell.
  it("leaves an unpaid invoice alone", () => {
    const plan = planInvoiceWriteback({ lines: [line({ status: "open" })], alreadyBookedRefs: none });
    expect(plan.writes).toEqual([]);
    expect(plan.skips[0].reason).toMatch(/not paid/);
  });

  // The double-depletion guard: the Export Bay already drained this.
  it("leaves an invoice with export transactions alone", () => {
    const plan = planInvoiceWriteback({
      lines: [line({ hasExportTransactions: true })],
      alreadyBookedRefs: none,
    });
    expect(plan.writes).toEqual([]);
    expect(plan.skips[0].reason).toMatch(/Export Bay/);
  });

  // Same guard from a different angle, so a missing shipment row cannot turn
  // into a silent second depletion.
  it.each(["export_invoice", "allocation_deposit"])("leaves app-raised type %s alone", (invoiceType) => {
    const plan = planInvoiceWriteback({ lines: [line({ invoiceType })], alreadyBookedRefs: none });
    expect(plan.writes).toEqual([]);
    expect(plan.skips[0].reason).toMatch(/app-raised/);
  });

  it("does not book a line that is already booked under its source_ref", () => {
    const plan = planInvoiceWriteback({
      lines: [line()],
      alreadyBookedRefs: new Set(["sqinvoice:INV-1:LI-1"]),
    });
    expect(plan.writes).toEqual([]);
  });

  it("books each line of a multi-line invoice separately", () => {
    const plan = planInvoiceWriteback({
      lines: [line({ lineItemId: "LI-1" }), line({ lineItemId: "LI-2", quantity: 2 })],
      alreadyBookedRefs: none,
    });
    expect(plan.writes.map((w) => w.sourceRef)).toEqual([
      "sqinvoice:INV-1:LI-1",
      "sqinvoice:INV-1:LI-2",
    ]);
  });

  it("resumes correctly when only part of an invoice was booked", () => {
    const plan = planInvoiceWriteback({
      lines: [line({ lineItemId: "LI-1" }), line({ lineItemId: "LI-2" })],
      alreadyBookedRefs: new Set(["sqinvoice:INV-1:LI-1"]),
    });
    expect(plan.writes.map((w) => w.sourceRef)).toEqual(["sqinvoice:INV-1:LI-2"]);
  });

  it("prefers the invoice's own channel over the default", () => {
    const plan = planInvoiceWriteback({ lines: [line({ channel: "wholesale" })], alreadyBookedRefs: none });
    expect(plan.writes[0].channel).toBe("wholesale");
  });

  it("ignores a zero or negative quantity", () => {
    const plan = planInvoiceWriteback({
      lines: [line({ quantity: 0 }), line({ lineItemId: "LI-2", quantity: -1 })],
      alreadyBookedRefs: none,
    });
    expect(plan.writes).toEqual([]);
  });

  it("reports one skip per invoice rather than one per line", () => {
    const plan = planInvoiceWriteback({
      lines: [
        line({ lineItemId: "LI-1", hasExportTransactions: true }),
        line({ lineItemId: "LI-2", hasExportTransactions: true }),
      ],
      alreadyBookedRefs: none,
    });
    expect(plan.skips).toHaveLength(1);
  });
});

describe("writebackSourceRef", () => {
  it("is stable per invoice line, which is what makes re-running safe", () => {
    expect(writebackSourceRef("INV-1", "LI-1")).toBe("sqinvoice:INV-1:LI-1");
    expect(writebackSourceRef("INV-1", "LI-2")).not.toBe(writebackSourceRef("INV-1", "LI-1"));
  });
});

describe("invoice writeback gate", () => {
  // Tripwire. This one depletes the APP's inventory, and unlike a Square count
  // there is no second system to notice a wrong deduction.
  it("is shut", () => {
    expect(INVOICE_WRITEBACK_ENABLED).toBe(false);
  });
});
