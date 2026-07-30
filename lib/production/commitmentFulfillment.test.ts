// lib/production/commitmentFulfillment.test.ts
//
// Characterization tests for checkAndFulfillCommitment. The function is async DB
// orchestration, but it encodes a precise gate sequence and the producedBbl /
// allocatedBbl / exportedBbl math that decides whether a commitment flips to
// "fulfilled". We drive it with a stub that returns fixed rows per table and
// records whether the commitments table got a fulfilled update, then assert the
// REAL decision (update issued or not) and the payload — not that a mock was
// called. Each early-return branch is covered, plus the percentage math and the
// exported < allocated boundary.
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkAndFulfillCommitment, recheckCommitmentFulfillment } from "./commitmentFulfillment";

interface Tables {
  allocation?: unknown;
  batch?: unknown;
  transfers?: unknown;
  exports?: unknown;
  commitment?: unknown;
}
interface Recorded { table: string; op: string; payload: unknown }

/**
 * Stub dispatching reads by table name. `.single()` resolves the per-table row;
 * `.in()` (transfers) and the export read resolve to arrays. commitments.update
 * is recorded.
 */
function stub(t: Tables): { client: SupabaseClient; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    let isUpdate = false;
    b.select = () => b;
    b.in = () => Promise.resolve({ data: t.transfers ?? [], error: null });
    b.single = () => {
      const data =
        table === "batch_allocations" ? t.allocation :
        table === "brew_batches" ? t.batch :
        table === "commitments" ? t.commitment : null;
      return Promise.resolve({ data: data ?? null, error: null });
    };
    b.update = (payload: unknown) => { isUpdate = true; recorded.push({ table, op: "update", payload }); return b; };
    // export_transactions read terminates on the third .eq.
    if (table === "export_transactions") {
      let eqCount = 0;
      b.eq = () => { eqCount += 1; return eqCount >= 3 ? Promise.resolve({ data: t.exports ?? [], error: null }) : b; };
    } else {
      // For the commitments table .eq serves both the read (→ .single()) and the
      // write (update().eq() terminal); resolve to success after an update.
      b.eq = () => (isUpdate ? Promise.resolve({ error: null }) : b);
    }
    return b;
  };
  return { client: { from } as unknown as SupabaseClient, recorded };
}

const fullAllocation = {
  id: "a1", batch_id: "b1", channel: "distribution", partner_id: "p1",
  percentage: 50, contract_request_id: "c1",
};

describe("checkAndFulfillCommitment", () => {
  it("returns early (no update) when the allocation has no contract_request_id", async () => {
    const { client, recorded } = stub({
      allocation: { ...fullAllocation, contract_request_id: null },
    });
    await checkAndFulfillCommitment(client, "a1");
    expect(recorded).toEqual([]);
  });

  it("returns early when the allocation row is missing", async () => {
    const { client, recorded } = stub({ allocation: null });
    await checkAndFulfillCommitment(client, "a1");
    expect(recorded).toEqual([]);
  });

  it("returns early when the batch is not yet complete", async () => {
    const { client, recorded } = stub({
      allocation: fullAllocation,
      batch: { status: "packaging" },
    });
    await checkAndFulfillCommitment(client, "a1");
    expect(recorded).toEqual([]);
  });

  it("returns early when producedBbl is zero (no kegging/canning)", async () => {
    const { client, recorded } = stub({
      allocation: fullAllocation,
      batch: { status: "complete" },
      transfers: [],
    });
    await checkAndFulfillCommitment(client, "a1");
    expect(recorded).toEqual([]);
  });

  it("does NOT fulfill when exported is below the allocated share", async () => {
    // produced = (10-0)+(10-0) = 20 ; allocated = 50% × 20 = 10 ; exported = 9 < 10
    const { client, recorded } = stub({
      allocation: fullAllocation,
      batch: { status: "complete" },
      transfers: [
        { volume_bbl: 10, shrinkage_bbl: 0, transfer_type: "kegging" },
        { volume_bbl: 10, shrinkage_bbl: 0, transfer_type: "canning" },
      ],
      exports: [{ volume_bbl: 9 }],
      commitment: { status: "pending" },
    });
    await checkAndFulfillCommitment(client, "a1");
    expect(recorded).toEqual([]);
  });

  it("fulfills when exported meets the allocated share (shrinkage ignored)", async () => {
    // produced = sum(volume_bbl) = 12+8 = 20 (shrinkage_bbl NOT subtracted) ;
    // allocated = 50% × 20 = 10 ; exported = 6+4 = 10 ≥ 10 → fulfill
    const { client, recorded } = stub({
      allocation: fullAllocation,
      batch: { status: "complete" },
      transfers: [
        { volume_bbl: 12, shrinkage_bbl: 2, transfer_type: "kegging" },
        { volume_bbl: 8, shrinkage_bbl: 1, transfer_type: "canning" },
      ],
      exports: [{ volume_bbl: 6 }, { volume_bbl: 4 }],
      commitment: { status: "pending" },
    });
    await checkAndFulfillCommitment(client, "a1");
    expect(recorded).toEqual([
      { table: "commitments", op: "update", payload: { status: "fulfilled" } },
    ]);
  });

  it("ignores shrinkage_bbl entirely: high shrinkage does not lower producedBbl", async () => {
    // produced = sum(volume_bbl) = 20 even with 5 bbl shrinkage ; allocated 10 ;
    // exported 10 → fulfill (old net-of-shrinkage math would have blocked this)
    const { client, recorded } = stub({
      allocation: fullAllocation,
      batch: { status: "complete" },
      transfers: [{ volume_bbl: 20, shrinkage_bbl: 5, transfer_type: "kegging" }],
      exports: [{ volume_bbl: 10 }],
      commitment: { status: "pending" },
    });
    await checkAndFulfillCommitment(client, "a1");
    expect(recorded).toHaveLength(1);
  });

  it("is idempotent: no update when the commitment is already fulfilled", async () => {
    const { client, recorded } = stub({
      allocation: fullAllocation,
      batch: { status: "complete" },
      transfers: [{ volume_bbl: 20, shrinkage_bbl: 0, transfer_type: "kegging" }],
      exports: [{ volume_bbl: 20 }],
      commitment: { status: "fulfilled" },
    });
    await checkAndFulfillCommitment(client, "a1");
    expect(recorded).toEqual([]);
  });

  it("treats missing shrinkage_bbl as zero in producedBbl", async () => {
    // produced = 20 - 0 = 20 ; allocated 50% = 10 ; exported 10 → fulfill
    const { client, recorded } = stub({
      allocation: fullAllocation,
      batch: { status: "complete" },
      transfers: [{ volume_bbl: 20, transfer_type: "kegging" }],
      exports: [{ volume_bbl: 10 }],
      commitment: { status: "pending" },
    });
    await checkAndFulfillCommitment(client, "a1");
    expect(recorded).toHaveLength(1);
  });
});

// ── recheckCommitmentFulfillment ──────────────────────────────────────────────
// The reversible sibling, used when a shipment edit releases allocation credits.
// Releasing credit can push a commitment back below its threshold, so
// fulfillment has to be able to go backwards. Same gates, same math, same stub —
// the only difference is that a fulfilled commitment can return to "open".
describe("recheckCommitmentFulfillment", () => {
  it("reverts fulfilled → open when exported falls below the allocated share", async () => {
    // produced = 20 ; allocated = 50% × 20 = 10 ; exported = 4 < 10
    const { client, recorded } = stub({
      allocation: fullAllocation,
      batch: { status: "complete" },
      transfers: [{ volume_bbl: 20, transfer_type: "kegging" }],
      exports: [{ volume_bbl: 4 }],
      commitment: { status: "fulfilled" },
    });
    await recheckCommitmentFulfillment(client, "a1");
    expect(recorded).toEqual([
      { table: "commitments", op: "update", payload: { status: "open" } },
    ]);
  });

  it("does not write when the commitment is already open and still below", async () => {
    const { client, recorded } = stub({
      allocation: fullAllocation,
      batch: { status: "complete" },
      transfers: [{ volume_bbl: 20, transfer_type: "kegging" }],
      exports: [{ volume_bbl: 4 }],
      commitment: { status: "open" },
    });
    await recheckCommitmentFulfillment(client, "a1");
    expect(recorded).toEqual([]);
  });

  it("does not write when fulfilled and exported is still at or above allocated", async () => {
    const { client, recorded } = stub({
      allocation: fullAllocation,
      batch: { status: "complete" },
      transfers: [{ volume_bbl: 20, transfer_type: "kegging" }],
      exports: [{ volume_bbl: 10 }],
      commitment: { status: "fulfilled" },
    });
    await recheckCommitmentFulfillment(client, "a1");
    expect(recorded).toEqual([]);
  });

  it("still fulfills on the way up, matching checkAndFulfillCommitment", async () => {
    const { client, recorded } = stub({
      allocation: fullAllocation,
      batch: { status: "complete" },
      transfers: [{ volume_bbl: 20, transfer_type: "kegging" }],
      exports: [{ volume_bbl: 10 }],
      commitment: { status: "open" },
    });
    await recheckCommitmentFulfillment(client, "a1");
    expect(recorded).toEqual([
      { table: "commitments", op: "update", payload: { status: "fulfilled" } },
    ]);
  });

  it("does not write in either direction when the batch is not complete", async () => {
    // A fulfilled commitment on an incomplete batch stays put: allocatedBbl is
    // still a moving target, so reverting on it would be meaningless.
    const { client, recorded } = stub({
      allocation: fullAllocation,
      batch: { status: "packaging" },
      transfers: [{ volume_bbl: 20, transfer_type: "kegging" }],
      exports: [{ volume_bbl: 0 }],
      commitment: { status: "fulfilled" },
    });
    await recheckCommitmentFulfillment(client, "a1");
    expect(recorded).toEqual([]);
  });

  it("does not write when the allocation has no contract_request_id", async () => {
    const { client, recorded } = stub({
      allocation: { ...fullAllocation, contract_request_id: null },
      commitment: { status: "fulfilled" },
    });
    await recheckCommitmentFulfillment(client, "a1");
    expect(recorded).toEqual([]);
  });

  it("does not write when producedBbl is zero", async () => {
    const { client, recorded } = stub({
      allocation: fullAllocation,
      batch: { status: "complete" },
      transfers: [],
      commitment: { status: "fulfilled" },
    });
    await recheckCommitmentFulfillment(client, "a1");
    expect(recorded).toEqual([]);
  });
});
