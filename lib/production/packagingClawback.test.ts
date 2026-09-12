import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { clawBackPlannedPackaging } from "./packagingClawback";

interface EntryRow { id: string; stage: string; volume_bbl: number | null }
interface Update { id: string; volume_bbl: number; cancelled: boolean; reason?: string }

function stub(entries: EntryRow[]) {
  const updates: Update[] = [];
  const from = (table: string) => {
    const match: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (k: string, v: unknown) => { match[k] = v; return b; };
    b.is = () => b;
    b.order = () => Promise.resolve({
      data: entries.filter((e) => e.stage === match.stage),
      error: null,
    });
    b.update = (payload: { volume_bbl: number; cancelled_at?: string; cancellation_reason?: string }) => ({
      eq: (_k: string, id: string) => {
        updates.push({
          id,
          volume_bbl: payload.volume_bbl,
          cancelled: payload.cancelled_at != null,
          reason: payload.cancellation_reason,
        });
        return Promise.resolve({ data: null, error: null });
      },
    });
    void table;
    return b;
  };
  return { client: { from } as unknown as SupabaseClient, updates };
}

describe("clawBackPlannedPackaging", () => {
  it("walks EVERY open kegging entry before touching canning, cancelling exhausted ones", async () => {
    const { client, updates } = stub([
      { id: "k1", stage: "kegging", volume_bbl: 4 },
      { id: "k2", stage: "kegging", volume_bbl: 3 },
      { id: "c1", stage: "canning", volume_bbl: 6 },
    ]);
    const remaining = await clawBackPlannedPackaging(client, "b1", 9, "Volume converted into another batch");
    expect(remaining).toBe(0);
    expect(updates).toEqual([
      { id: "k1", volume_bbl: 0, cancelled: true, reason: "Volume converted into another batch" },
      { id: "k2", volume_bbl: 0, cancelled: true, reason: "Volume converted into another batch" },
      { id: "c1", volume_bbl: 4, cancelled: false, reason: undefined },
    ]);
  });

  it("returns the volume nothing was left to absorb", async () => {
    const { client } = stub([{ id: "k1", stage: "kegging", volume_bbl: 2 }]);
    expect(await clawBackPlannedPackaging(client, "b1", 5, "r")).toBe(3);
  });

  it("skips volume-less entries and no-ops on zero volume", async () => {
    const { client, updates } = stub([{ id: "k1", stage: "kegging", volume_bbl: null }]);
    expect(await clawBackPlannedPackaging(client, "b1", 2, "r")).toBe(2);
    expect(updates).toEqual([]);
    expect(await clawBackPlannedPackaging(client, "b1", 0, "r")).toBe(0);
  });
});
