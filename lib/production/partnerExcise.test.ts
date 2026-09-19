import { describe, expect, it } from "vitest";
import { excisePerPartner } from "./partnerExcise";

describe("excisePerPartner", () => {
  const invoices = [
    { id: "paid", partner_id: "argus", status: "paid" },
    { id: "open", partner_id: "argus", status: "open" },
    { id: "void", partner_id: "argus", status: "voided" },
    { id: "other", partner_id: "fortnight", status: "paid" },
    { id: "nobody", partner_id: null, status: "paid" },
  ];
  const lines = [
    { invoice_id: "paid", total_cents: 1000 }, { invoice_id: "paid", total_cents: "500" },
    { invoice_id: "open", total_cents: 300 }, { invoice_id: "void", total_cents: 9999 },
    { invoice_id: "other", total_cents: 70 }, { invoice_id: "nobody", total_cents: 5 }, { invoice_id: "missing", total_cents: 5 },
  ];

  it("charges every live line, collects only what sits on paid invoices, and ignores voids", () => {
    expect(excisePerPartner(invoices, lines)).toEqual({
      argus: { charged_cents: 1800, collected_cents: 1500, outstanding_cents: 300, invoices: 2 },
      fortnight: { charged_cents: 70, collected_cents: 70, outstanding_cents: 0, invoices: 1 },
    });
  });
});
