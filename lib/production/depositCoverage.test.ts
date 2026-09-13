import { describe, it, expect } from "vitest";
import { classifyAdditions, classifyBase, type CoverageAllocFields } from "./depositCoverage";

function fields(over: Partial<CoverageAllocFields> = {}): CoverageAllocFields {
  return {
    invoice_paid_at: null,
    invoice_sent_at: null,
    invoice_generated_at: null,
    deposit_backcharged_invoice_id: null,
    square_deposit_invoice_id: null,
    refund_amount_cents: null,
    written_off_at: null,
    ...over,
  };
}

describe("classifyAdditions", () => {
  it("settled via back-charge: paid with a back-charge pointer (the Mule #000061 shape)", () => {
    expect(classifyAdditions(fields({ invoice_paid_at: "t", deposit_backcharged_invoice_id: "inv" })))
      .toMatchObject({ status: "settled", via: "backcharge" });
  });
  it("settled via own deposit invoice", () => {
    expect(classifyAdditions(fields({ invoice_paid_at: "t", square_deposit_invoice_id: "sq" })))
      .toMatchObject({ status: "settled", via: "own_invoice" });
  });
  it("pending when invoiced (either way) but unpaid; uncharged when nothing exists", () => {
    expect(classifyAdditions(fields({ deposit_backcharged_invoice_id: "inv" })).status).toBe("pending_invoice");
    expect(classifyAdditions(fields({ invoice_sent_at: "t", square_deposit_invoice_id: "sq" })).status).toBe("pending_invoice");
    expect(classifyAdditions(fields())).toEqual({ status: "uncharged", via: null, chargedCents: 0, collectedCents: 0 });
  });
  it("back-charges collected per invoice: unpaid → pending, all paid but not settled → collecting", () => {
    const pending = classifyAdditions(fields({ deposit_backcharged_invoice_id: "inv2" }), { chargedCents: 1000, collectedCents: 400, unpaidCount: 1 });
    expect(pending).toEqual({ status: "pending_invoice", via: "backcharge", chargedCents: 1000, collectedCents: 400 });
    const collecting = classifyAdditions(fields({ deposit_backcharged_invoice_id: "inv1" }), { chargedCents: 400, collectedCents: 400, unpaidCount: 0 });
    expect(collecting.status).toBe("collecting");
    expect(collecting.via).toBe("backcharge");
    // The settle path stamps invoice_paid_at once the allocation is fully delivered.
    expect(classifyAdditions(fields({ invoice_paid_at: "t" }), { chargedCents: 900, collectedCents: 900, unpaidCount: 0 }))
      .toMatchObject({ status: "settled", via: "backcharge", collectedCents: 900 });
  });

  it("written off wins over everything", () => {
    expect(classifyAdditions(fields({ written_off_at: "t", invoice_paid_at: "t" })).status).toBe("written_off");
  });
});

describe("classifyBase", () => {
  it("not a conversion child → no base component", () => {
    expect(classifyBase(false, null).status).toBe("not_conversion");
  });
  it("covered by the parent's paid deposit (B-025 -> B-057 before the refund)", () => {
    expect(classifyBase(true, fields({ invoice_paid_at: "t" })).status).toBe("covered");
  });
  it("REFUNDED parent deposit makes base chargeable — the agreed rule", () => {
    const b = classifyBase(true, fields({ invoice_paid_at: "t", refund_amount_cents: 99950 }));
    expect(b.status).toBe("refunded_chargeable");
    expect(b.parentRefundCents).toBe(99950);
  });
  it("no parent contract allocation at all → uncovered", () => {
    expect(classifyBase(true, null).status).toBe("uncovered");
  });
  it("parent deposit not yet billed/paid → pending on the parent's side, never re-billed here", () => {
    expect(classifyBase(true, fields()).status).toBe("pending_parent");
    expect(classifyBase(true, fields({ invoice_sent_at: "t" })).status).toBe("pending_parent");
  });
  it("a written-off parent deposit still counts as covered (claim settled)", () => {
    expect(classifyBase(true, fields({ written_off_at: "t" })).status).toBe("covered");
  });
});
