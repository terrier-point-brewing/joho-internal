import { describe, it, expect } from "vitest";
import { attentionRank, commitmentAttention } from "./ledgerAttention";
import type { LedgerAllocation, LedgerCommitment } from "./partnerLedger";

function alloc(over: Partial<LedgerAllocation["deposit"]> = {}): LedgerAllocation {
  return {
    id: "a", batch_number: "B-056", batch_status: "fermenting", beer_name: "Pilsner", percentage: 70,
    batch_planned_bbl: 40, batch_unallocated_pct: 0, produced_bbl: 28.16, owed_bbl: 19.71, exported_bbl: 24.39,
    remaining_bbl: 0, written_off_bbl: null, write_off_note: null,
    deposit: { state: "uncharged", via: null, invoice: null, paid_at: null, paid_cents: 0, refunded_cents: 0, charged_cents: 0, collected_cents: 0, backcharge_invoices: [], ...over },
  };
}

function commitment(over: Partial<LedgerCommitment> = {}, totals: Partial<LedgerCommitment["totals"]> = {}): LedgerCommitment {
  return {
    id: "c", recipe_name: "Pilsner", channel: "contract_brewing", stage: "delivered", booked_bbl: 22.83,
    desired_delivery_date: "2026-09-20", received_on: null, locked_on: null, is_split: false, notes: null,
    allocations: [alloc()], shipments: [], export_invoices: [],
    totals: { owed_bbl: 19.71, shipped_bbl: 24.39, remaining_bbl: 0, uninvoiced_bbl: 19.89, deposit_billed_cents: 0, deposit_paid_cents: 0, deposit_refunded_cents: 0, export_billed_cents: 0, export_paid_cents: 0, ...totals },
    ...over,
  };
}

describe("commitmentAttention", () => {
  it("B-056 today: unbilled beer first, then the uncharged deposit, then the over-shipment", () => {
    const flags = commitmentAttention(commitment(), "2026-09-13").map((f) => f.kind);
    expect(flags).toEqual(["not_invoiced", "deposit_uncharged", "over_shipped"]);
    expect(attentionRank(commitment(), "2026-09-13")).toBe(1);
  });

  it("a fulfilled deal with everything billed and paid needs nothing", () => {
    const c = commitment({ stage: "fulfilled", allocations: [alloc({ state: "settled", paid_at: "2026-05-01", paid_cents: 100000 })] }, { uninvoiced_bbl: 0, shipped_bbl: 19.71 });
    expect(commitmentAttention(c, "2026-09-13")).toEqual([]);
    expect(attentionRank(c, "2026-09-13")).toBe(99);
  });

  it("past due only counts while the deal is still open and undelivered", () => {
    const late = commitment({ stage: "shipping", desired_delivery_date: "2026-08-01", allocations: [alloc({ state: "settled", paid_at: "t", paid_cents: 1 })] }, { uninvoiced_bbl: 0, shipped_bbl: 10 });
    expect(commitmentAttention(late, "2026-09-13").map((f) => f.kind)).toEqual(["overdue"]);
    expect(commitmentAttention({ ...late, stage: "delivered" }, "2026-09-13")).toEqual([]);
  });

  it("a paid-then-written-off deposit with no amount is the lowest-priority flag", () => {
    const c = commitment({ stage: "written_off", allocations: [alloc({ state: "written_off", paid_at: "2026-05-08" })] }, { uninvoiced_bbl: 0, shipped_bbl: 9, owed_bbl: 13.75 });
    expect(commitmentAttention(c, "2026-09-13").map((f) => f.kind)).toEqual(["amount_unrecorded"]);
  });

  it("an unplanned deal needs a batch; distribution deals never get deposit flags", () => {
    expect(commitmentAttention(commitment({ stage: "unplanned", allocations: [] }, { uninvoiced_bbl: 0, shipped_bbl: 0, owed_bbl: 0 }), "2026-09-13").map((f) => f.kind)).toEqual(["needs_batch"]);
    expect(commitmentAttention(commitment({ channel: "distribution", stage: "shipping" }, { uninvoiced_bbl: 0, shipped_bbl: 5, owed_bbl: 10 }), "2026-09-13")).toEqual([]);
  });
});
