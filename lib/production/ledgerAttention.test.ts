import { describe, it, expect } from "vitest";
import { attentionRank, commitmentAttention } from "./ledgerAttention";
import type { LedgerAllocation, LedgerCommitment } from "./partnerLedger";

function alloc(over: Partial<LedgerAllocation> = {}, deposit: Partial<LedgerAllocation["deposit"]> = {}): LedgerAllocation {
  return {
    id: "a", batch_number: "B-056", batch_status: "fermenting", beer_name: "Pilsner", percentage: 70,
    batch_planned_bbl: 40, batch_unallocated_pct: 0, batch_converted_pct: 0, batch_converted_to: [], produced_bbl: 28.16, owed_bbl: 19.71, exported_bbl: 24.39,
    remaining_bbl: 0, in_tank_bbl: 0, written_off_bbl: null, write_off_note: null,
    deposit: { state: "uncharged", via: null, invoice: null, paid_at: null, paid_cents: 0, refunded_cents: 0, charged_cents: 0, collected_cents: 0, backcharge_invoices: [], ...deposit },
    ...over,
  };
}

function commitment(over: Partial<LedgerCommitment> = {}, totals: Partial<LedgerCommitment["totals"]> = {}): LedgerCommitment {
  return {
    id: "c", recipe_name: "Pilsner", channel: "contract_brewing", stage: "closed", booked_bbl: 22.83,
    desired_delivery_date: "2026-09-20", received_on: null, locked_on: null, is_split: false, notes: null,
    allocations: [alloc()], shipments: [], export_invoices: [],
    totals: { owed_bbl: 19.71, shipped_bbl: 24.39, remaining_bbl: 0, in_tank_bbl: 0, uninvoiced_bbl: 19.89, deposit_billed_cents: 0, deposit_paid_cents: 0, deposit_refunded_cents: 0, export_billed_cents: 0, export_paid_cents: 0, ...totals },
    ...over,
  };
}

describe("commitmentAttention", () => {
  it("B-056 (closed, over-shipped, unbilled, no deposit): money first, then the over-delivery as a note", () => {
    const flags = commitmentAttention(commitment());
    expect(flags.map((f) => [f.kind, f.actionable])).toEqual([
      ["not_invoiced", true],
      ["deposit_uncharged", true],
      ["over_delivered", false],
    ]);
    expect(attentionRank(commitment())).toBe(1);
  });

  it("an open deal that over-shipped is asked to bill it; a closed one only notes it", () => {
    const open = commitment({ stage: "open", allocations: [alloc({}, { state: "settled", paid_at: "t", paid_cents: 1 })] }, { uninvoiced_bbl: 0 });
    expect(commitmentAttention(open)).toEqual([{ kind: "over_delivered", severity: 5, label: "4.68 bbl over", actionable: true }]);
    expect(attentionRank(open)).toBe(5);
    const closed = { ...open, stage: "closed" as const };
    expect(commitmentAttention(closed)[0].actionable).toBe(false);
    expect(attentionRank(closed)).toBe(99);
  });

  it("a closed deal written off short carries a note, not an action", () => {
    const c = commitment(
      { stage: "closed", allocations: [alloc({ owed_bbl: 13.75, exported_bbl: 9, written_off_bbl: 4.75 }, { state: "written_off", paid_at: "2026-05-08" })] },
      { uninvoiced_bbl: 0, shipped_bbl: 9, owed_bbl: 13.75 },
    );
    expect(commitmentAttention(c).map((f) => [f.kind, f.actionable])).toEqual([["amount_unrecorded", true], ["under_delivered", false]]);
    expect(attentionRank(c)).toBe(6);
  });

  it("a closed deal with everything billed and paid needs nothing", () => {
    const c = commitment({ allocations: [alloc({ exported_bbl: 19.71 }, { state: "settled", paid_at: "2026-05-01", paid_cents: 100000 })] }, { uninvoiced_bbl: 0, shipped_bbl: 19.71 });
    expect(commitmentAttention(c)).toEqual([]);
    expect(attentionRank(c)).toBe(99);
  });

  it("deposit not charged only once there is beer; needs a batch when nothing is allocated", () => {
    const brewing = commitment({ stage: "open", allocations: [alloc({ produced_bbl: 0, exported_bbl: 0, owed_bbl: 0 })] }, { uninvoiced_bbl: 0, shipped_bbl: 0, owed_bbl: 0 });
    expect(commitmentAttention(brewing)).toEqual([]);
    const packaged = commitment({ stage: "open", allocations: [alloc({ produced_bbl: 10, exported_bbl: 0, owed_bbl: 7 })] }, { uninvoiced_bbl: 0, shipped_bbl: 0, owed_bbl: 7 });
    expect(commitmentAttention(packaged).map((f) => f.kind)).toEqual(["deposit_uncharged"]);
    expect(commitmentAttention(commitment({ stage: "open", allocations: [] }, { uninvoiced_bbl: 0, shipped_bbl: 0, owed_bbl: 0 })).map((f) => f.kind)).toEqual(["needs_batch"]);
  });

  it("distribution deals never get deposit flags", () => {
    expect(commitmentAttention(commitment({ channel: "distribution", stage: "open" }, { uninvoiced_bbl: 0, shipped_bbl: 5, owed_bbl: 10 }))).toEqual([]);
  });
});
