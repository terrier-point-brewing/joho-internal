import { describe, it, expect } from "vitest";
import {
  classifySourceEdit,
  coverageTransfers,
  invoiceState,
  partnerTie,
  seedChildAllocations,
  validatePlan,
  type SourceAllocationInput,
} from "./conversionAllocationPlan";

function alloc(overrides: Partial<SourceAllocationInput> = {}): SourceAllocationInput {
  return {
    id: "a1",
    channel: "contract_brewing",
    partner_id: "p1",
    partner_name: "Argus",
    contract_request_id: "c1",
    percentage: 75,
    invoice_generated_at: null,
    invoice_sent_at: null,
    invoice_paid_at: null,
    deposit_amount_paid_cents: null,
    square_payment_id: null,
    written_off_at: null,
    ...overrides,
  };
}

describe("invoiceState", () => {
  it("ranks paid > sent > generated > none", () => {
    expect(invoiceState(alloc())).toBe("none");
    expect(invoiceState(alloc({ invoice_generated_at: "t" }))).toBe("generated");
    expect(invoiceState(alloc({ invoice_generated_at: "t", invoice_sent_at: "t" }))).toBe("sent");
    expect(invoiceState(alloc({ invoice_generated_at: "t", invoice_sent_at: "t", invoice_paid_at: "t" }))).toBe("paid");
  });
});

describe("seedChildAllocations", () => {
  it("copies the source mix verbatim, keyed back to its source rows", () => {
    const source = [
      alloc({ id: "a1", percentage: 75 }),
      alloc({ id: "a2", channel: "taproom", partner_id: null, partner_name: null, contract_request_id: null, percentage: 12.5 }),
    ];
    expect(seedChildAllocations(source)).toEqual([
      expect.objectContaining({ source_allocation_id: "a1", percentage: 75, contract_request_id: "c1" }),
      expect.objectContaining({ source_allocation_id: "a2", channel: "taproom", percentage: 12.5 }),
    ]);
  });
  it("leaves written-off allocations behind", () => {
    expect(seedChildAllocations([alloc({ written_off_at: "t" })])).toEqual([]);
  });
});

describe("classifySourceEdit", () => {
  it("is a plain patch with no invoice, patch+revise with an unpaid one", () => {
    expect(classifySourceEdit(alloc(), 50)).toEqual({ kind: "patch" });
    expect(classifySourceEdit(alloc({ invoice_generated_at: "t" }), 50)).toEqual({ kind: "patch_and_revise" });
    expect(classifySourceEdit(alloc({ invoice_generated_at: "t", invoice_sent_at: "t" }), 50)).toEqual({ kind: "patch_and_revise" });
  });

  it("prices a paid reduction with issueDepositReduction's exact rounding", () => {
    const a = alloc({
      invoice_generated_at: "t", invoice_sent_at: "t", invoice_paid_at: "t",
      deposit_amount_paid_cents: 82_500, square_payment_id: "pay_1",
    });
    // 75% -> 73.75%: 82500 * (1 - 73.75/75) = 1375
    expect(classifySourceEdit(a, 73.75)).toEqual({ kind: "refund", refundCents: 1375 });
  });

  it("blocks a paid reduction without a payment on file, and any paid increase", () => {
    const noPayment = alloc({ invoice_paid_at: "t", deposit_amount_paid_cents: 100, square_payment_id: null });
    expect(classifySourceEdit(noPayment, 50).kind).toBe("blocked_refund");
    const paid = alloc({ invoice_paid_at: "t", deposit_amount_paid_cents: 100, square_payment_id: "pay" });
    expect(classifySourceEdit(paid, 80).kind).toBe("blocked_increase");
  });

  it("treats no-change as unchanged even when paid", () => {
    expect(classifySourceEdit(alloc({ invoice_paid_at: "t" }), 75)).toEqual({ kind: "unchanged" });
  });
});

describe("coverageTransfers", () => {
  const paid = alloc({
    invoice_generated_at: "t", invoice_sent_at: "t", invoice_paid_at: "t",
    deposit_amount_paid_cents: 100, square_payment_id: "pay",
  });

  it("pairs a paid source allocation with a child draft on the same commitment", () => {
    const drafts = seedChildAllocations([paid]);
    expect(coverageTransfers([paid], drafts)).toEqual([
      { sourceAllocationId: "a1", contractRequestId: "c1" },
    ]);
  });

  it("does not fire for unpaid sources, zeroed drafts, or different commitments", () => {
    expect(coverageTransfers([alloc()], seedChildAllocations([alloc()]))).toEqual([]);
    const zeroed = seedChildAllocations([paid]).map((d) => ({ ...d, percentage: 0 }));
    expect(coverageTransfers([paid], zeroed)).toEqual([]);
    const other = seedChildAllocations([paid]).map((d) => ({ ...d, contract_request_id: "c9" }));
    expect(coverageTransfers([paid], other)).toEqual([]);
  });
});

describe("partnerTie", () => {
  it("the seeded default keeps every party whole", () => {
    const source = [
      alloc({ id: "a1", percentage: 75 }),
      alloc({ id: "a2", channel: "taproom", partner_id: null, partner_name: null, contract_request_id: null, percentage: 12.5 }),
    ];
    const rows = partnerTie(source, {}, seedChildAllocations(source), 40, 24);
    // 75% of 40 = 30 before; 75% of 16 + 75% of 24 = 30 after.
    const argus = rows.find((r) => r.label === "Argus")!;
    expect(argus.beforeBbl).toBe(30);
    expect(argus.afterBbl).toBe(30);
    expect(argus.dropped).toBe(false);
  });

  it("flags the party whose child share is removed", () => {
    const source = [alloc({ id: "a1", percentage: 75 })];
    const drafts = seedChildAllocations(source).map((d) => ({ ...d, percentage: 0 }));
    const rows = partnerTie(source, {}, drafts, 40, 24);
    expect(rows[0].beforeBbl).toBe(30);
    expect(rows[0].afterBbl).toBe(12); // 75% of the 16 bbl remainder
    expect(rows[0].dropped).toBe(true);
  });

  it("a source reduction paired with a full child hand-off stays whole", () => {
    // The B-025 repair shape: 0.5 bbl moved from the source's 75% to a child
    // allocated 100% to the same partner.
    const source = [alloc({ id: "a1", percentage: 75 })];
    const drafts = [{
      source_allocation_id: "a1", channel: "contract_brewing", partner_id: "p1",
      partner_name: "Argus", contract_request_id: "c1", percentage: 100,
    }];
    const rows = partnerTie(source, { a1: 73.75 }, drafts, 40, 0.5);
    expect(rows[0].beforeBbl).toBe(30);
    // 73.75% of 39.5 + 100% of 0.5 = 29.131 + 0.5 = 29.631 — the estimate is
    // guidance, not equality: the real repair trued up on packaged volume.
    expect(rows[0].afterBbl).toBeCloseTo(29.631, 3);
  });
});

describe("validatePlan", () => {
  const paid = alloc({
    invoice_generated_at: "t", invoice_sent_at: "t", invoice_paid_at: "t",
    deposit_amount_paid_cents: 82_500, square_payment_id: "pay",
  });

  it("collects refunds, revisions and coverage in one pass", () => {
    const source = [paid, alloc({ id: "a2", partner_name: "Bodega", contract_request_id: "c2", percentage: 10, invoice_generated_at: "t" })];
    const drafts = seedChildAllocations(source);
    const plan = validatePlan(source, { a1: 73.75, a2: 8 }, drafts);
    expect(plan.blockers).toEqual([]);
    expect(plan.refunds).toEqual([{ allocationId: "a1", partnerName: "Argus", refundCents: 1375 }]);
    expect(plan.revisions).toEqual(["a2"]);
    expect(plan.coverage).toEqual([{ sourceAllocationId: "a1", contractRequestId: "c1" }]);
  });

  it("blocks over-allocation of the child and impossible refunds", () => {
    const noPayment = alloc({ invoice_paid_at: "t", deposit_amount_paid_cents: 100, square_payment_id: null });
    const drafts = [
      { source_allocation_id: null, channel: "taproom", partner_id: null, partner_name: null, contract_request_id: null, percentage: 60 },
      { source_allocation_id: null, channel: "distribution", partner_id: null, partner_name: null, contract_request_id: null, percentage: 50 },
    ];
    const plan = validatePlan([noPayment], { a1: 50 }, drafts);
    expect(plan.blockers.some((b) => b.includes("more than 100%"))).toBe(true);
    expect(plan.blockers.some((b) => b.includes("Square Dashboard"))).toBe(true);
  });
});
