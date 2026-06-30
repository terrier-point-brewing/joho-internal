// lib/production/batchCompletion.test.ts
//
// Characterization tests for checkAndCompleteBatch. This module is pure
// orchestration (no arithmetic), so the load-bearing behavior is its branch
// logic: it only transitions a batch to "complete" when batch_exhaustion says
// is_exhausted AND the batch isn't already complete, and when it does it writes
// the status, a history row with a fixed note, and releases commitments. We
// drive it with a stub returning fixed rows and recording mutations, then assert
// the REAL decision + the exact payloads written — not that a mock was called.
// Branches covered: not exhausted, exhausted+already complete (idempotent),
// exhausted+incomplete (full transition), and the null-exhaustion-row case.
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkAndCompleteBatch } from "./batchCompletion";

interface Recorded { table: string; op: string; payload: unknown }

function stub(opts: { exhaustion: unknown; batch: unknown }): { client: SupabaseClient; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.is = () => b; // releaseCommitments uses .update().eq().is()
    b.single = () => {
      const data = table === "batch_exhaustion" ? opts.exhaustion
        : table === "brew_batches" ? opts.batch : null;
      return Promise.resolve({ data: data ?? null, error: null });
    };
    b.update = (payload: unknown) => { recorded.push({ table, op: "update", payload }); return b; };
    b.insert = (payload: unknown) => { recorded.push({ table, op: "insert", payload }); return Promise.resolve({ error: null }); };
    return b;
  };
  return { client: { from } as unknown as SupabaseClient, recorded };
}

describe("checkAndCompleteBatch", () => {
  it("no-ops when the batch is not exhausted", async () => {
    const { client, recorded } = stub({ exhaustion: { is_exhausted: false }, batch: { status: "packaging" } });
    await checkAndCompleteBatch(client, "b1");
    expect(recorded).toEqual([]);
  });

  it("no-ops when there is no batch_exhaustion row", async () => {
    const { client, recorded } = stub({ exhaustion: null, batch: { status: "packaging" } });
    await checkAndCompleteBatch(client, "b1");
    expect(recorded).toEqual([]);
  });

  it("is idempotent: no-ops when the batch is already complete", async () => {
    const { client, recorded } = stub({ exhaustion: { is_exhausted: true }, batch: { status: "complete" } });
    await checkAndCompleteBatch(client, "b1");
    expect(recorded).toEqual([]);
  });

  it("transitions to complete, writes a history row, and releases commitments", async () => {
    const { client, recorded } = stub({ exhaustion: { is_exhausted: true }, batch: { status: "packaging" } });
    await checkAndCompleteBatch(client, "b1");

    const batchUpdate = recorded.find((r) => r.table === "brew_batches" && r.op === "update");
    expect(batchUpdate?.payload).toEqual({ status: "complete" });

    const history = recorded.find((r) => r.table === "batch_status_history");
    expect(history?.op).toBe("insert");
    expect(history?.payload).toEqual({
      batch_id: "b1", status: "complete", note: "Auto: fully packaged",
    });

    // releaseCommitments issues an update against batch_ingredient_commitments
    const release = recorded.find((r) => r.table === "batch_ingredient_commitments");
    expect(release?.op).toBe("update");
    expect((release?.payload as { released_at: string }).released_at).toBeTypeOf("string");
  });
});
