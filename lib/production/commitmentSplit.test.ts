import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { splitCommitmentForConversionChild } from "./commitmentSplit";

function stub(parent: {
  id: string; recipe_id: string; partner_id: string; channel: string;
  volume_bbl: number; desired_delivery_date: string | null; received_on: string | null;
} | null, credited: { allocations: Array<{ id: string }>; exports: Array<{ volume_bbl: number }> } = { allocations: [], exports: [] }) {
  const writes: Array<{ op: string; payload: Record<string, unknown> }> = [];
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    // batch_allocations.select("id").eq(...) is awaited directly (thenable);
    // commitments.select(...).eq(...).maybeSingle() keeps chaining.
    b.eq = () => (table === "batch_allocations"
      ? Promise.resolve({ data: credited.allocations, error: null })
      : b);
    b.in = () => Promise.resolve({ data: credited.exports, error: null });
    b.maybeSingle = () => Promise.resolve({ data: parent, error: null });
    b.insert = (payload: Record<string, unknown>) => {
      writes.push({ op: "insert", payload });
      return { select: () => ({ single: () => Promise.resolve({ data: { id: "new-commit" }, error: null }) }) };
    };
    b.update = (payload: Record<string, unknown>) => {
      writes.push({ op: "update", payload });
      return { eq: () => Promise.resolve({ data: null, error: null }) };
    };
    void table;
    return b;
  };
  return { client: { from } as unknown as SupabaseClient, writes };
}

const PARENT = {
  id: "ec025f1f-aaaa-bbbb-cccc-000000000000", recipe_id: "pilsner", partner_id: "argus",
  channel: "contract_brewing", volume_bbl: 28, desired_delivery_date: "2026-09-20", received_on: "2026-08-01",
};

describe("splitCommitmentForConversionChild", () => {
  it("splits a different-recipe deal: new child commitment, parent shrinks", async () => {
    const { client, writes } = stub(PARENT);
    const id = await splitCommitmentForConversionChild(client, {
      commitmentId: PARENT.id, childRecipeId: "orange", volumeBbl: 5.17,
      deliveryDate: "2026-08-31", childLabel: "#B-063 Orange Pilsner",
    });
    expect(id).toBe("new-commit");
    expect(writes[0].payload).toMatchObject({
      recipe_id: "orange", partner_id: "argus", channel: "contract_brewing",
      volume_bbl: 5.17, desired_delivery_date: "2026-08-31", received_on: "2026-08-01", status: "open",
    });
    expect(writes[1].payload).toMatchObject({ volume_bbl: 22.83 });
  });

  it("no split when the commitment already matches the child's recipe", async () => {
    const { client, writes } = stub({ ...PARENT, recipe_id: "orange" });
    const id = await splitCommitmentForConversionChild(client, {
      commitmentId: PARENT.id, childRecipeId: "orange", volumeBbl: 5.17, childLabel: "x",
    });
    expect(id).toBe(PARENT.id);
    expect(writes).toEqual([]);
  });

  it("falls back to the parent's delivery date and never drives the parent negative", async () => {
    const { client, writes } = stub({ ...PARENT, volume_bbl: 3 });
    await splitCommitmentForConversionChild(client, {
      commitmentId: PARENT.id, childRecipeId: "orange", volumeBbl: 5.17, childLabel: "x",
    });
    expect(writes[0].payload).toMatchObject({ desired_delivery_date: "2026-09-20" });
    expect(writes[1].payload).toMatchObject({ volume_bbl: 0 });
  });

  it("refuses to shrink the deal below what has already shipped against it (B-056 → B-063)", async () => {
    // 28 bbl deal, 24.39 bbl already credited to its allocation: only 3.61 is free.
    const { client, writes } = stub(PARENT, { allocations: [{ id: "alloc-56" }], exports: [{ volume_bbl: 24.39 }] });
    await expect(splitCommitmentForConversionChild(client, {
      commitmentId: PARENT.id, childRecipeId: "orange", volumeBbl: 5.17, childLabel: "#B-063 Orange Pilsner",
    })).rejects.toThrow(/24\.39 bbl has already shipped.*only 3\.61 bbl/);
    expect(writes).toEqual([]);
  });

  it("splits freely while the moved volume fits in what is still unshipped", async () => {
    const { client, writes } = stub(PARENT, { allocations: [{ id: "alloc-56" }], exports: [{ volume_bbl: 20 }] });
    await splitCommitmentForConversionChild(client, {
      commitmentId: PARENT.id, childRecipeId: "orange", volumeBbl: 5.17, childLabel: "x",
    });
    expect(writes[1].payload).toMatchObject({ volume_bbl: 22.83 });
  });

  it("zero or negative moved volume is a no-op", async () => {
    const { client, writes } = stub(PARENT);
    const id = await splitCommitmentForConversionChild(client, {
      commitmentId: PARENT.id, childRecipeId: "orange", volumeBbl: 0, childLabel: "x",
    });
    expect(id).toBe(PARENT.id);
    expect(writes).toEqual([]);
  });
});
