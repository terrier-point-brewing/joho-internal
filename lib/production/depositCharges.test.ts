import { describe, it, expect } from "vitest";
import { summarizeDepositCharges } from "./depositCharges";

describe("summarizeDepositCharges", () => {
  it("splits charged vs collected by the invoice's status and skips voided invoices", () => {
    const m = summarizeDepositCharges([
      { allocation_id: "a", invoice_id: "i1", amount_cents: 48218, shipped_bbl: 5.23, created_at: "2026-09-10", invoices: { status: "paid" } },
      { allocation_id: "a", invoice_id: "i2", amount_cents: 61000, shipped_bbl: 6.66, created_at: "2026-09-12", invoices: { status: "open" } },
      { allocation_id: "a", invoice_id: "i3", amount_cents: 99999, shipped_bbl: 8, created_at: "2026-09-11", invoices: { status: "voided" } },
      { allocation_id: "b", invoice_id: "i4", amount_cents: 100, shipped_bbl: 1, created_at: "2026-09-01", invoices: [{ status: "paid" }] },
    ]);
    expect(m.get("a")).toEqual({
      chargedCents: 109218, collectedCents: 48218, unpaidCount: 1, chargedBbl: 11.89, invoiceIds: ["i2", "i1"],
    });
    expect(m.get("b")?.collectedCents).toBe(100);
    expect(m.get("b")?.unpaidCount).toBe(0);
  });

  it("empty input → empty map", () => {
    expect(summarizeDepositCharges([]).size).toBe(0);
  });
});
