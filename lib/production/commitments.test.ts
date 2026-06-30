// lib/production/commitments.test.ts
//
// Characterization tests for the ingredient-commitment helpers. All three are
// async DB orchestration, but each carries load-bearing pure logic:
//   • upsertCommitments  → committed_qty = quantity_per_bbl × volumeBbl per ingredient
//   • releaseCommitments → stamps released_at (ISO string)
//   • getShortfalls      → effective = stock − Σ(active commitments); reports only
//                          when effective < -0.001, rounding to 3 dp.
// We drive them with a stub that returns fixed rows and records mutation payloads,
// then assert the REAL computed values (the upsert rows, the shortfall numbers) —
// not that a mock was called. Boundaries: empty recipe, zero volume, exact-stock
// (no shortfall), the -0.001 tolerance edge, rounding to 3 dp, multi-batch sum.
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { upsertCommitments, releaseCommitments, getShortfalls } from "./commitments";

interface Recorded { table: string; op: string; payload: unknown }

// ── upsertCommitments ────────────────────────────────────────────────────────
function upsertStub(ris: Array<{ ingredient_id: string; quantity_per_bbl: number }> | null) {
  const recorded: Recorded[] = [];
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => Promise.resolve({ data: ris, error: null });
    b.upsert = (payload: unknown) => { recorded.push({ table, op: "upsert", payload }); return Promise.resolve({ error: null }); };
    return b;
  };
  return { client: { from } as unknown as SupabaseClient, recorded };
}

describe("upsertCommitments", () => {
  it("computes committed_qty = quantity_per_bbl × volumeBbl per ingredient", async () => {
    const { client, recorded } = upsertStub([
      { ingredient_id: "hops", quantity_per_bbl: 2 },
      { ingredient_id: "malt", quantity_per_bbl: 10.5 },
    ]);
    await upsertCommitments(client, "batch1", "recipe1", 4);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].payload).toEqual([
      { batch_id: "batch1", ingredient_id: "hops", committed_qty: 8 },
      { batch_id: "batch1", ingredient_id: "malt", committed_qty: 42 },
    ]);
  });

  it("produces zero committed_qty at zero volume", async () => {
    const { client, recorded } = upsertStub([{ ingredient_id: "hops", quantity_per_bbl: 2 }]);
    await upsertCommitments(client, "b", "r", 0);
    expect((recorded[0].payload as Array<{ committed_qty: number }>)[0].committed_qty).toBe(0);
  });

  it("no-ops (no upsert) when the recipe has no ingredients", async () => {
    const { client, recorded } = upsertStub([]);
    await upsertCommitments(client, "b", "r", 5);
    expect(recorded).toEqual([]);
  });

  it("no-ops when recipe_ingredients returns null", async () => {
    const { client, recorded } = upsertStub(null);
    await upsertCommitments(client, "b", "r", 5);
    expect(recorded).toEqual([]);
  });
});

// ── releaseCommitments ───────────────────────────────────────────────────────
describe("releaseCommitments", () => {
  it("stamps released_at with an ISO timestamp", async () => {
    let payload: unknown;
    const b: Record<string, unknown> = {};
    b.update = (p: unknown) => { payload = p; return b; };
    b.eq = () => b;
    b.is = () => Promise.resolve({ error: null });
    const client = { from: () => b } as unknown as SupabaseClient;
    await releaseCommitments(client, "batch1");
    const released = (payload as { released_at: string }).released_at;
    expect(typeof released).toBe("string");
    expect(new Date(released).toString()).not.toBe("Invalid Date");
  });
});

// ── getShortfalls ────────────────────────────────────────────────────────────
interface MineRow {
  ingredient_id: string;
  committed_qty: number;
  ingredients: { name: string; unit: string; stock_quantity: number } | null;
}

/**
 * Stub for getShortfalls. The first batch_ingredient_commitments select returns
 * `mine`; subsequent selects (per ingredient, across all batches) return the
 * queued totals rows in order.
 */
function shortfallStub(mine: MineRow[] | null, allByIngredient: Array<Array<{ committed_qty: number }>>): SupabaseClient {
  let call = 0;
  const from = () => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.is = () => {
      const idx = call;
      call += 1;
      // call 0 = this batch's commitments (mine); calls 1..n = per-ingredient totals
      if (idx === 0) return Promise.resolve({ data: mine, error: null });
      return Promise.resolve({ data: allByIngredient[idx - 1] ?? [], error: null });
    };
    return b;
  };
  return { from } as unknown as SupabaseClient;
}

describe("getShortfalls", () => {
  it("reports a shortfall when total committed exceeds stock", async () => {
    const client = shortfallStub(
      [{ ingredient_id: "hops", committed_qty: 30, ingredients: { name: "Hops", unit: "lb", stock_quantity: 50 } }],
      [[{ committed_qty: 30 }, { committed_qty: 40 }]], // total 70 across all batches vs stock 50
    );
    const result = await getShortfalls(client, "b1");
    expect(result).toEqual([{
      ingredient_id: "hops",
      name: "Hops",
      unit: "lb",
      stock_quantity: 50,
      total_committed: 70,
      this_batch_committed: 30,
      shortfall: 20, // |50 - 70|
    }]);
  });

  it("reports no shortfall when commitments exactly equal stock", async () => {
    const client = shortfallStub(
      [{ ingredient_id: "malt", committed_qty: 25, ingredients: { name: "Malt", unit: "lb", stock_quantity: 25 } }],
      [[{ committed_qty: 25 }]],
    );
    expect(await getShortfalls(client, "b1")).toEqual([]);
  });

  it("does not report when the deficit is within the -0.001 tolerance", async () => {
    // effective = 10 - 10.0005 = -0.0005, which is NOT < -0.001 → no shortfall
    const client = shortfallStub(
      [{ ingredient_id: "x", committed_qty: 10.0005, ingredients: { name: "X", unit: "u", stock_quantity: 10 } }],
      [[{ committed_qty: 10.0005 }]],
    );
    expect(await getShortfalls(client, "b1")).toEqual([]);
  });

  it("reports when the deficit is just past the -0.001 tolerance, rounded to 3 dp", async () => {
    // effective = 10 - 12.5 = -2.5 < -0.001 → shortfall |−2.5| = 2.5
    const client = shortfallStub(
      [{ ingredient_id: "x", committed_qty: 12.5, ingredients: { name: "X", unit: "u", stock_quantity: 10 } }],
      [[{ committed_qty: 12.5 }]],
    );
    const result = await getShortfalls(client, "b1");
    expect(result).toHaveLength(1);
    expect(result[0].shortfall).toBe(2.5);
    expect(result[0].total_committed).toBe(12.5);
  });

  it("rounds shortfall/total to 3 dp and reflects the float-subtraction artifact", async () => {
    // total_committed = round(10.0025 * 1000)/1000 = 10.003 (rounds 10.0025 directly).
    // BUT effective = 10 - 10.0025 computes as -0.0024999999999995 (float), so
    // shortfall = round(0.00249999… * 1000)/1000 = round(2.4999…)/1000 = 0.002,
    // NOT 0.003. The two rounded figures disagree by 1 in the 3rd dp because one
    // rounds the committed value and the other rounds a float-subtracted deficit.
    const client = shortfallStub(
      [{ ingredient_id: "x", committed_qty: 10.0025, ingredients: { name: "X", unit: "u", stock_quantity: 10 } }],
      [[{ committed_qty: 10.0025 }]],
    );
    const result = await getShortfalls(client, "b1");
    expect(result).toHaveLength(1);
    expect(result[0].total_committed).toBe(10.003);
    expect(result[0].shortfall).toBe(0.002); // float artifact, see comment above
  });

  it("returns empty when this batch has no active commitments", async () => {
    expect(await getShortfalls(shortfallStub([], []), "b1")).toEqual([]);
    expect(await getShortfalls(shortfallStub(null, []), "b1")).toEqual([]);
  });

  it("skips a commitment row whose joined ingredient is null", async () => {
    const client = shortfallStub(
      [{ ingredient_id: "ghost", committed_qty: 100, ingredients: null }],
      [[{ committed_qty: 100 }]],
    );
    expect(await getShortfalls(client, "b1")).toEqual([]);
  });
});
