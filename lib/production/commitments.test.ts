// lib/production/commitments.test.ts
//
// Characterization tests for the ingredient-commitment helpers. All three are
// async DB orchestration, but each carries load-bearing pure logic:
//   • upsertCommitments  → committed_qty = quantity_per_turn × turns per ingredient
//   • releaseCommitments → stamps released_at (ISO string)
//   • getShortfalls      → stock is claimed by pre-brew batches in
//                          planned_brew_date order; this batch is short only on
//                          what earlier-dated batches leave behind. Reports when
//                          the remainder is < -0.001, rounding to 3 dp.
// We drive them with a stub that returns fixed rows and records mutation payloads,
// then assert the REAL computed values (the upsert rows, the shortfall numbers) —
// not that a mock was called. Boundaries: empty recipe, a single turn, exact-stock
// (no shortfall), the -0.001 tolerance edge, rounding to 3 dp, priority ordering
// (earlier date wins, undated sorts last, same-date ties break on batch_id),
// post-planning batches excluded, and the yeast re-pitch exemption.
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { upsertCommitments, releaseCommitments, resyncRecipeCommitments, getShortfalls } from "./commitments";

interface Recorded { table: string; op: string; payload: unknown }

// ── upsertCommitments ────────────────────────────────────────────────────────
// Two chains now run per call: the upsert of the recipe's lines, and a prune
// that releases every unreleased commitment NOT in the recipe. The stub records
// both, including the `.not("ingredient_id","in",…)` filter — that filter is the
// whole fix, so an assertion that ignored it would pass on the buggy version.
function upsertStub(ris: Array<{ ingredient_id: string; quantity_per_turn: number }> | null) {
  const recorded: Recorded[] = [];
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    let update: Record<string, unknown> | null = null;
    let notFilter: string | null = null;
    b.select = () => b;
    b.eq = () => (update ? b : Promise.resolve({ data: ris, error: null }));
    b.is = () => b;
    b.not = (col: string, op: string, val: string) => {
      notFilter = `${col} ${op} ${val}`;
      recorded.push({ table, op: "prune", payload: { released_at: update?.released_at, filter: notFilter } });
      return Promise.resolve({ error: null });
    };
    b.update = (p: Record<string, unknown>) => {
      update = p;
      // releaseCommitments ends at .is(); prune continues to .not(). Record the
      // bare release now and let .not() overwrite it with the pruning variant.
      recorded.push({ table, op: "release", payload: p });
      return b;
    };
    b.upsert = (payload: unknown) => { recorded.push({ table, op: "upsert", payload }); return Promise.resolve({ error: null }); };
    return b;
  };
  return { client: { from } as unknown as SupabaseClient, recorded };
}

describe("upsertCommitments", () => {
  it("computes committed_qty = quantity_per_turn × turns per ingredient", async () => {
    const { client, recorded } = upsertStub([
      { ingredient_id: "hops", quantity_per_turn: 2 },
      { ingredient_id: "malt", quantity_per_turn: 10.5 },
    ]);
    await upsertCommitments(client, "batch1", "recipe1", 4);
    const upserts = recorded.filter((r) => r.op === "upsert");
    expect(upserts).toHaveLength(1);
    // released_at: null is load-bearing — (batch_id, ingredient_id) is unique
    // regardless of released_at, so an ingredient pruned by an earlier swap and
    // since restored resolves to the released row and must be revived.
    expect(upserts[0].payload).toEqual([
      { batch_id: "batch1", ingredient_id: "hops", committed_qty: 8, released_at: null },
      { batch_id: "batch1", ingredient_id: "malt", committed_qty: 42, released_at: null },
    ]);
  });

  // The recipe is the bill for ONE turn, so a single-turn batch commits it
  // verbatim. This is the B-058 regression: the old rate round-trip divided by
  // expected_yield_bbl (19.5) and multiplied back by volume (20), turning an
  // entered 55 lb into 56.41. A lower yield never adds grain.
  it("commits the per-turn quantity verbatim for a single turn", async () => {
    const { client, recorded } = upsertStub([{ ingredient_id: "debittered-black", quantity_per_turn: 55 }]);
    await upsertCommitments(client, "b58", "black-lager", 1);
    const upsert = recorded.find((r) => r.op === "upsert")!;
    expect((upsert.payload as Array<{ committed_qty: number }>)[0].committed_qty).toBe(55);
  });

  // The B-056 regression: swapping a batch onto a new recipe must not leave the
  // old recipe's ingredients committed. Everything outside the new line-up is
  // released in the same pass as the upsert.
  it("releases commitments for ingredients no longer in the recipe", async () => {
    const { client, recorded } = upsertStub([
      { ingredient_id: "pilsner-malt", quantity_per_turn: 16.5 },
      { ingredient_id: "hallertau", quantity_per_turn: 0.178 },
    ]);
    await upsertCommitments(client, "b56", "pilsner", 40);
    const prune = recorded.find((r) => r.op === "prune");
    expect(prune).toBeDefined();
    const { filter, released_at } = prune!.payload as { filter: string; released_at: string };
    expect(filter).toBe("ingredient_id in (pilsner-malt,hallertau)");
    expect(new Date(released_at).toString()).not.toBe("Invalid Date");
  });

  it("releases every commitment when the recipe has no ingredients", async () => {
    const { client, recorded } = upsertStub([]);
    await upsertCommitments(client, "b", "r", 5);
    expect(recorded.filter((r) => r.op === "upsert")).toEqual([]);
    expect(recorded.some((r) => r.op === "release")).toBe(true);
  });

  it("releases every commitment when recipe_ingredients returns null", async () => {
    const { client, recorded } = upsertStub(null);
    await upsertCommitments(client, "b", "r", 5);
    expect(recorded.filter((r) => r.op === "upsert")).toEqual([]);
    expect(recorded.some((r) => r.op === "release")).toBe(true);
  });
});

// ── resyncRecipeCommitments ──────────────────────────────────────────────────
describe("resyncRecipeCommitments", () => {
  it("re-commits every pre-brew batch at its own turn count, and only those", async () => {
    const ris = [{ ingredient_id: "malt", quantity_per_turn: 10 }];
    const batches = [
      { id: "b1", turns: 2 },
      { id: "b2", turns: 1 },
      { id: "b3", turns: null },   // unset turns falls back to a single turn
    ];
    let statusFilter: string[] | null = null;
    const upserts: unknown[] = [];
    const from = (table: string) => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => (table === "recipe_ingredients" ? Promise.resolve({ data: ris, error: null }) : b);
      b.in = (_col: string, vals: string[]) => { statusFilter = vals; return Promise.resolve({ data: batches, error: null }); };
      b.is = () => b;
      b.not = () => Promise.resolve({ error: null });
      b.update = () => b;
      b.upsert = (p: unknown) => { upserts.push(p); return Promise.resolve({ error: null }); };
      return b;
    };
    await resyncRecipeCommitments({ from } as unknown as SupabaseClient, "pilsner");

    // Post-planning batches already had stock physically deducted; re-committing
    // them would double-charge, so the query must not reach past pre-brew.
    expect(statusFilter).toEqual(["planning", "backlog"]);
    expect(upserts).toEqual([
      [{ batch_id: "b1", ingredient_id: "malt", committed_qty: 20, released_at: null }],
      [{ batch_id: "b2", ingredient_id: "malt", committed_qty: 10, released_at: null }],
      [{ batch_id: "b3", ingredient_id: "malt", committed_qty: 10, released_at: null }],
    ]);
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
  ingredients: { name: string; unit: string; stock_quantity: number; category?: string | null } | null;
}
interface AllRow {
  batch_id: string;
  committed_qty: number;
  brew_batches: { status: string; planned_brew_date: string | null } | null;
}

/**
 * Stub for getShortfalls. Terminal calls in order:
 *   1. .is()         → this batch's own commitments (`mine`)
 *   2. .maybeSingle()→ this batch's planned_brew_date
 *   3.. .is()        → per-ingredient commitments across every batch, in order
 */
function shortfallStub(
  mine: MineRow[] | null,
  allByIngredient: Array<AllRow[]>,
  myDate: string | null = "2026-01-01",
): SupabaseClient {
  let isCall = 0;
  const from = () => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.maybeSingle = () => Promise.resolve({ data: { planned_brew_date: myDate }, error: null });
    b.is = () => {
      const idx = isCall;
      isCall += 1;
      if (idx === 0) return Promise.resolve({ data: mine, error: null });
      return Promise.resolve({ data: allByIngredient[idx - 1] ?? [], error: null });
    };
    return b;
  };
  return { from } as unknown as SupabaseClient;
}

const planning = (planned_brew_date: string | null) => ({ status: "planning", planned_brew_date });

describe("getShortfalls", () => {
  it("reports a shortfall when this batch alone exceeds stock", async () => {
    const client = shortfallStub(
      [{ ingredient_id: "hops", committed_qty: 70, ingredients: { name: "Hops", unit: "lb", stock_quantity: 50 } }],
      [[{ batch_id: "b1", committed_qty: 70, brew_batches: planning("2026-01-01") }]],
    );
    expect(await getShortfalls(client, "b1")).toEqual([{
      ingredient_id: "hops",
      name: "Hops",
      unit: "lb",
      stock_quantity: 50,
      total_committed: 70,
      this_batch_committed: 70,
      available_to_batch: 50,
      shortfall: 20,
    }]);
  });

  it("ignores commitments held by batches that already left planning", async () => {
    // The regression that made B-034 report 9 phantom shorts: B-045 brewed in
    // April but never released its reservation, so its already-consumed stock
    // was counted a second time against every batch still in planning.
    const client = shortfallStub(
      [{ ingredient_id: "malt", committed_qty: 770, ingredients: { name: "Prairie Select", unit: "lb", stock_quantity: 770 } }],
      [[
        { batch_id: "b1",   committed_qty: 770, brew_batches: planning("2026-07-13") },
        { batch_id: "done", committed_qty: 770, brew_batches: { status: "complete", planned_brew_date: "2026-04-17" } },
      ]],
      "2026-07-13",
    );
    expect(await getShortfalls(client, "b1")).toEqual([]);
  });

  it("gives the earlier-dated batch first claim on contested stock", async () => {
    const contested: AllRow[] = [
      { batch_id: "early", committed_qty: 30, brew_batches: planning("2026-07-13") },
      { batch_id: "late",  committed_qty: 30, brew_batches: planning("2026-08-04") },
    ];
    // Stock 50: "early" brews first and fits.
    expect(await getShortfalls(
      shortfallStub([{ ingredient_id: "h", committed_qty: 30, ingredients: { name: "H", unit: "lb", stock_quantity: 50 } }], [contested], "2026-07-13"),
      "early",
    )).toEqual([]);

    // …and "late" absorbs the genuine over-booking: only 20 is left for its 30.
    const lateResult = await getShortfalls(
      shortfallStub([{ ingredient_id: "h", committed_qty: 30, ingredients: { name: "H", unit: "lb", stock_quantity: 50 } }], [contested], "2026-08-04"),
      "late",
    );
    expect(lateResult).toHaveLength(1);
    expect(lateResult[0].available_to_batch).toBe(20);
    expect(lateResult[0].shortfall).toBe(10);
    expect(lateResult[0].total_committed).toBe(60);
  });

  it("sorts an undated batch last, behind every dated one", async () => {
    const rows: AllRow[] = [
      { batch_id: "dated",   committed_qty: 40, brew_batches: planning("2026-07-13") },
      { batch_id: "undated", committed_qty: 40, brew_batches: planning(null) },
    ];
    const result = await getShortfalls(
      shortfallStub([{ ingredient_id: "h", committed_qty: 40, ingredients: { name: "H", unit: "lb", stock_quantity: 50 } }], [rows], null),
      "undated",
    );
    expect(result).toHaveLength(1);
    expect(result[0].available_to_batch).toBe(10); // 50 − the dated batch's 40
  });

  it("breaks a same-date tie on batch_id so ordering is stable across requests", async () => {
    const rows: AllRow[] = [
      { batch_id: "aaa", committed_qty: 40, brew_batches: planning("2026-07-13") },
      { batch_id: "bbb", committed_qty: 40, brew_batches: planning("2026-07-13") },
    ];
    const mine = [{ ingredient_id: "h", committed_qty: 40, ingredients: { name: "H", unit: "lb", stock_quantity: 50 } }];
    expect(await getShortfalls(shortfallStub(mine, [rows], "2026-07-13"), "aaa")).toEqual([]);
    expect(await getShortfalls(shortfallStub(mine, [rows], "2026-07-13"), "bbb")).toHaveLength(1);
  });

  it("skips Yeast-category ingredients when the batch is a re-pitch", async () => {
    const mine = [{ ingredient_id: "y", committed_qty: 2, ingredients: { name: "Wy1318", unit: "L", stock_quantity: 0, category: "Yeast" } }];
    const rows: Array<AllRow[]> = [[{ batch_id: "b1", committed_qty: 2, brew_batches: planning("2026-01-01") }]];
    expect(await getShortfalls(shortfallStub(mine, rows), "b1")).toHaveLength(1);
    expect(await getShortfalls(shortfallStub(mine, rows), "b1", { excludeYeast: true })).toEqual([]);
  });

  it("reports no shortfall when this batch's commitment exactly equals stock", async () => {
    const client = shortfallStub(
      [{ ingredient_id: "malt", committed_qty: 25, ingredients: { name: "Malt", unit: "lb", stock_quantity: 25 } }],
      [[{ batch_id: "b1", committed_qty: 25, brew_batches: planning("2026-01-01") }]],
    );
    expect(await getShortfalls(client, "b1")).toEqual([]);
  });

  it("does not report when the deficit is within the -0.001 tolerance", async () => {
    // effective = 10 - 10.0005 = -0.0005, which is NOT < -0.001 → no shortfall
    const client = shortfallStub(
      [{ ingredient_id: "x", committed_qty: 10.0005, ingredients: { name: "X", unit: "u", stock_quantity: 10 } }],
      [[{ batch_id: "b1", committed_qty: 10.0005, brew_batches: planning("2026-01-01") }]],
    );
    expect(await getShortfalls(client, "b1")).toEqual([]);
  });

  it("rounds shortfall/total to 3 dp and reflects the float-subtraction artifact", async () => {
    // total_committed = round(10.0025 * 1000)/1000 = 10.003 (rounds 10.0025 directly).
    // BUT effective = 10 - 10.0025 computes as -0.0024999999999995 (float), so
    // shortfall = round(0.00249999… * 1000)/1000 = 0.002, NOT 0.003. The two
    // rounded figures disagree by 1 in the 3rd dp because one rounds the
    // committed value and the other rounds a float-subtracted deficit.
    const client = shortfallStub(
      [{ ingredient_id: "x", committed_qty: 10.0025, ingredients: { name: "X", unit: "u", stock_quantity: 10 } }],
      [[{ batch_id: "b1", committed_qty: 10.0025, brew_batches: planning("2026-01-01") }]],
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
      [[{ batch_id: "b1", committed_qty: 100, brew_batches: planning("2026-01-01") }]],
    );
    expect(await getShortfalls(client, "b1")).toEqual([]);
  });
});

describe("getShortfalls — an earlier batch's own deficit does not roll forward", () => {
  it("reports only this batch's unmet need when the prior claim already exceeds stock", async () => {
    // Prod case: Pilsner Malt at 0 on hand. B-054 (Jul 21) claims 660 it can't
    // have; B-056 (Aug 4) needs 450. B-056 is short 450 — not 1110.
    const rows: AllRow[] = [
      { batch_id: "early", committed_qty: 660, brew_batches: planning("2026-07-21") },
      { batch_id: "late",  committed_qty: 450, brew_batches: planning("2026-08-04") },
    ];
    const result = await getShortfalls(
      shortfallStub(
        [{ ingredient_id: "p", committed_qty: 450, ingredients: { name: "Pilsner Malt", unit: "lb", stock_quantity: 0 } }],
        [rows],
        "2026-08-04",
      ),
      "late",
    );
    expect(result).toHaveLength(1);
    expect(result[0].available_to_batch).toBe(0);
    expect(result[0].shortfall).toBe(450);
  });

  it("still subtracts a prior claim that stock can actually cover", async () => {
    const rows: AllRow[] = [
      { batch_id: "early", committed_qty: 40, brew_batches: planning("2026-07-13") },
      { batch_id: "late",  committed_qty: 30, brew_batches: planning("2026-08-04") },
    ];
    const result = await getShortfalls(
      shortfallStub(
        [{ ingredient_id: "h", committed_qty: 30, ingredients: { name: "H", unit: "lb", stock_quantity: 50 } }],
        [rows],
        "2026-08-04",
      ),
      "late",
    );
    expect(result[0].available_to_batch).toBe(10); // 50 − 40, not clamped
    expect(result[0].shortfall).toBe(20);
  });
});
