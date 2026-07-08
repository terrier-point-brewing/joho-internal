import { describe, it, expect } from "vitest";
import { mapSquareInvoiceStatus } from "./invoiceStatus";

describe("mapSquareInvoiceStatus", () => {
  it("maps each Square status to the unified ledger status", () => {
    expect(mapSquareInvoiceStatus("DRAFT")).toBe("draft");
    expect(mapSquareInvoiceStatus("UNPAID")).toBe("open");
    expect(mapSquareInvoiceStatus("SCHEDULED")).toBe("open");
    expect(mapSquareInvoiceStatus("PARTIALLY_PAID")).toBe("partial");
    expect(mapSquareInvoiceStatus("PAID")).toBe("paid");
    expect(mapSquareInvoiceStatus("PARTIALLY_REFUNDED")).toBe("paid");
    expect(mapSquareInvoiceStatus("CANCELED")).toBe("voided");
    expect(mapSquareInvoiceStatus("REFUNDED")).toBe("voided");
    expect(mapSquareInvoiceStatus("FAILED")).toBe("voided");
  });

  it("is case-insensitive", () => {
    expect(mapSquareInvoiceStatus("paid")).toBe("paid");
  });

  it("returns 'unknown' for anything unexpected", () => {
    expect(mapSquareInvoiceStatus("WHATEVER")).toBe("unknown");
    expect(mapSquareInvoiceStatus("")).toBe("unknown");
  });
});
