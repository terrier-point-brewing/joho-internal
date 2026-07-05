// lib/production/exportTransactionWriter.test.ts
//
// The invoice-lifecycle status a freshly written export row starts at depends
// only on its channel: taproom consumption is internal (paid at the point of
// sale) and terminal, every partner channel starts in the invoicing workflow.
import { describe, it, expect } from "vitest";
import { initialExportStatus } from "./exportTransactionWriter";

describe("initialExportStatus", () => {
  it("forwards taproom straight to paid (never enters invoicing)", () => {
    expect(initialExportStatus("taproom")).toBe("paid");
  });

  it("starts every partner channel at invoice_required", () => {
    expect(initialExportStatus("distribution")).toBe("invoice_required");
    expect(initialExportStatus("wholesale")).toBe("invoice_required");
    expect(initialExportStatus("contract_brewing")).toBe("invoice_required");
  });
});
