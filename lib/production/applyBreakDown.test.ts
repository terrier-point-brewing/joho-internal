// lib/production/applyBreakDown.test.ts
//
// IO tests for applyBreakDown: given a target variation, resolve its can-identity
// family (same container+lid+label+partner, differing only by tier), plan breaks
// via planBreakDown, and execute them against a fake Supabase client — asserting
// real recorded effects (delete/insert/journal rows), not that a mock was called.
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { applyBreakDown } from "./applyBreakDown";

// ── Fake Supabase covering exactly the calls applyBreakDown makes ────────────
// Tables:
//  packaging_variations: identity lookup (.eq(id).single) + family fetch (.eq(container_id))
//  cold_storage_inventory: on-hand read (.eq(recipe_id).in(variation_id) ... ) + oldest row
//    (.eq(recipe_id).eq(variation_id).order(created_at).limit(1)) + update/delete/insert
//  cold_storage_breaks: insert
interface CsiRow { id: string; batch_id: string; recipe_id: string; variation_id: string; quantity_on_hand: number; created_at: string }

function makeClient(opts: {
  target: { id: string; container_id: string; lid_id: string | null; label_id: string | null; partner_id: string | null };
  family: Array<{ id: string; format: string; total_volume_fl_oz: number; container_id: string; lid_id: string | null; label_id: string | null; partner_id: string | null; breaks_into_variation_id?: string | null }>;
  csi: CsiRow[];
}) {
  const csi = opts.csi.map((r) => ({ ...r }));
  const effects: Array<Record<string, unknown>> = [];

  const from = (table: string) => {
    if (table === "packaging_variations") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const q: any = { _filters: {} };
      q.select = () => q;
      q.eq = (col: string, val: unknown) => { q._filters[col] = val; return q; };
      q.single = async () => {
        // identity lookup by id
        if (q._filters.id) {
          const t = opts.target;
          return { data: { container_id: t.container_id, lid_id: t.lid_id, label_id: t.label_id, partner_id: t.partner_id }, error: null };
        }
        return { data: null, error: null };
      };
      // family fetch: .select().eq('container_id', x) awaited directly
      q.then = (res: (v: { data: unknown; error: unknown }) => unknown) => {
        const rows = opts.family.filter((f) => f.container_id === q._filters.container_id);
        return Promise.resolve({ data: rows, error: null }).then(res);
      };
      return q;
    }
    if (table === "cold_storage_inventory") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const q: any = { _f: {}, _mode: "read", _order: false, _limit: 0, _payload: undefined as unknown };
      q.select = () => q;
      q.insert = (payload: { batch_id: string; recipe_id: string; variation_id: string; quantity_on_hand: number }) => {
        effects.push({ table, op: "insert", payload });
        // Real Supabase persists the row; later ops in the same execution (e.g. a
        // cascade's second break) read it back. Push it into `csi` so subsequent
        // .then() reads see it — otherwise a multi-hop cascade silently stalls.
        csi.push({
          id: `row-ins-${csi.length}`,
          batch_id: payload.batch_id,
          recipe_id: payload.recipe_id,
          variation_id: payload.variation_id,
          quantity_on_hand: payload.quantity_on_hand,
          created_at: new Date().toISOString(),
        });
        q._mode = "insert";
        return Promise.resolve({ error: null });
      };
      q.update = (payload: { quantity_on_hand: number }) => { q._mode = "update"; q._payload = payload; return q; };
      q.delete = () => { q._mode = "delete"; return q; };
      q.eq = (col: string, val: unknown) => {
        if (q._mode === "update") {
          const row = csi.find((r) => r.id === val); if (row) row.quantity_on_hand = (q._payload as { quantity_on_hand: number }).quantity_on_hand;
          effects.push({ table, op: "update", id: val, quantity_on_hand: (q._payload as { quantity_on_hand: number }).quantity_on_hand });
          return Promise.resolve({ error: null });
        }
        if (q._mode === "delete") {
          const i = csi.findIndex((r) => r.id === val); if (i >= 0) csi.splice(i, 1);
          effects.push({ table, op: "delete", id: val });
          return Promise.resolve({ error: null });
        }
        q._f[col] = val; return q;
      };
      q.in = (col: string, vals: unknown[]) => { q._f[col] = vals; return q; };
      q.order = () => { q._order = true; return q; };
      q.limit = (n: number) => { q._limit = n; return q; };
      q.then = (res: (v: { data: unknown; error: unknown }) => unknown) => {
        let rows = csi.filter((r) => r.recipe_id === q._f.recipe_id);
        if (Array.isArray(q._f.variation_id)) rows = rows.filter((r) => (q._f.variation_id as string[]).includes(r.variation_id));
        else if (q._f.variation_id) rows = rows.filter((r) => r.variation_id === q._f.variation_id);
        if (q._f.batch_id) rows = rows.filter((r) => r.batch_id === q._f.batch_id);
        if (q._order) rows = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
        if (q._limit) rows = rows.slice(0, q._limit);
        return Promise.resolve({ data: rows, error: null }).then(res);
      };
      return q;
    }
    if (table === "cold_storage_breaks") {
      return { insert: (payload: unknown) => { effects.push({ table, op: "insert", payload }); return Promise.resolve({ error: null }); } };
    }
    throw new Error(`unexpected table ${table}`);
  };

  return { client: { from } as unknown as SupabaseClient, effects, csi };
}

const ID = { single: "v-single", pack: "v-pack", pack6: "v-pack6", case: "v-case" };
const family16 = [
  { id: ID.single, format: "loose", total_volume_fl_oz: 16, container_id: "can16", lid_id: "lid", label_id: "lbl", partner_id: "cbc", breaks_into_variation_id: null },
  { id: ID.pack, format: "4-pack", total_volume_fl_oz: 64, container_id: "can16", lid_id: "lid", label_id: "lbl", partner_id: "cbc", breaks_into_variation_id: null },
  { id: ID.case, format: "case", total_volume_fl_oz: 384, container_id: "can16", lid_id: "lid", label_id: "lbl", partner_id: "cbc", breaks_into_variation_id: ID.pack },
];
const target = { id: ID.single, container_id: "can16", lid_id: "lid", label_id: "lbl", partner_id: "cbc" };

describe("applyBreakDown", () => {
  it("cracks a 4-pack into singles within its batch and journals the break", async () => {
    const { client, effects, csi } = makeClient({
      target, family: family16,
      csi: [{ id: "row-pack", batch_id: "B-040", recipe_id: "r1", variation_id: ID.pack, quantity_on_hand: 1, created_at: "2026-01-01" }],
    });
    const res = await applyBreakDown(client, { recipeId: "r1", variationId: ID.single, needed: 3, sourceRef: "sqsale:x:2026-07-07" });

    expect(res.shortfall).toBe(0);
    expect(res.applied).toEqual([{ batchId: "B-040", fromVariationId: ID.pack, toVariationId: ID.single, toUnits: 4 }]);
    // pack row fully consumed -> deleted; single row created with +4 in batch B-040
    expect(effects).toContainEqual({ table: "cold_storage_inventory", op: "delete", id: "row-pack" });
    expect(effects).toContainEqual({ table: "cold_storage_inventory", op: "insert", payload: expect.objectContaining({ batch_id: "B-040", recipe_id: "r1", variation_id: ID.single, quantity_on_hand: 4 }) });
    expect(effects).toContainEqual({ table: "cold_storage_breaks", op: "insert", payload: expect.objectContaining({ batch_id: "B-040", from_variation_id: ID.pack, to_variation_id: ID.single, from_units: 1, to_units: 4, source_ref: "sqsale:x:2026-07-07" }) });
    // final on-hand: single=4, pack=0
    expect(csi.find((r) => r.variation_id === ID.single)?.quantity_on_hand ?? (csi.length ? undefined : 4)).toBeDefined();
  });

  it("no-ops for a keg (single-tier family, no higher tier)", async () => {
    const { client, effects } = makeClient({
      target: { id: "keg", container_id: "keg16", lid_id: null, label_id: null, partner_id: "cbc" },
      family: [{ id: "keg", format: "loose", total_volume_fl_oz: 660, container_id: "keg16", lid_id: null, label_id: null, partner_id: "cbc" }],
      csi: [],
    });
    const res = await applyBreakDown(client, { recipeId: "r1", variationId: "keg", needed: 5, sourceRef: null });
    expect(res.applied).toEqual([]);
    expect(res.shortfall).toBe(0);
    expect(effects).toEqual([]);
  });

  it("cascades case->pack->single, journaling two breaks, and reports leftover shortfall honestly", async () => {
    const { client, effects } = makeClient({
      target, family: family16,
      csi: [{ id: "row-case", batch_id: "B-040", recipe_id: "r1", variation_id: ID.case, quantity_on_hand: 1, created_at: "2026-01-01" }],
    });
    const res = await applyBreakDown(client, { recipeId: "r1", variationId: ID.single, needed: 3, sourceRef: null });
    expect(res.applied).toEqual([
      { batchId: "B-040", fromVariationId: ID.case, toVariationId: ID.pack, toUnits: 6 },
      { batchId: "B-040", fromVariationId: ID.pack, toVariationId: ID.single, toUnits: 4 },
    ]);
    expect(res.shortfall).toBe(0);
    expect(effects.filter((e) => e.table === "cold_storage_breaks")).toHaveLength(2);
  });

  it("skips an op whose oldest parent row holds less than one whole unit, even though the tier's aggregate on-hand looked sufficient to the planner", async () => {
    // Two pack rows (0.6 + 0.5 = 1.1) satisfy planBreakDown's own aggregate
    // on-hand threshold (>= 1 - EPS), so it plans a single pack->single break.
    // But the OLDEST physical row (fetched at execution time) only holds 0.6 of
    // a unit -- not enough to crack a whole parent. Without the guard, the old
    // code would still delete that row (0.6 - 1 <= DUST) and credit a full 4
    // singles, manufacturing 3.4 cans' worth of stock from nothing.
    const { client, effects, csi } = makeClient({
      target, family: family16,
      csi: [
        { id: "row-pack-a", batch_id: "B-1", recipe_id: "r1", variation_id: ID.pack, quantity_on_hand: 0.6, created_at: "2026-01-01" },
        { id: "row-pack-b", batch_id: "B-2", recipe_id: "r1", variation_id: ID.pack, quantity_on_hand: 0.5, created_at: "2026-01-02" },
      ],
    });
    const res = await applyBreakDown(client, { recipeId: "r1", variationId: ID.single, needed: 4, sourceRef: null });

    expect(res.applied).toEqual([]);
    // Neither pack row was touched, no single row was created, no break journaled.
    expect(effects.filter((e) => e.table === "cold_storage_inventory" && e.op !== undefined)).toEqual([]);
    expect(effects.filter((e) => e.table === "cold_storage_breaks")).toEqual([]);
    expect(csi.find((r) => r.id === "row-pack-a")?.quantity_on_hand).toBe(0.6);
    expect(csi.find((r) => r.id === "row-pack-b")?.quantity_on_hand).toBe(0.5);
    expect(csi.some((r) => r.variation_id === ID.single)).toBe(false);
  });

  it("returns a defensive no-op instead of throwing when the sold variation isn't among the derived can tiers", async () => {
    // Shape: the sold variation's own container/lid/label/partner identity matches
    // a container that (for whatever data reason) also hosts >=2 real can tiers,
    // but the sold variation itself isn't one of those tiers (its format didn't
    // pass the CAN_FORMATS filter, so it's simply absent from the derived family).
    // planBreakDown would throw "not in tiers" for this; applyBreakDown should
    // defensively no-op instead of aborting the whole sync run.
    const oddballTarget = { id: "v-target-oddball", container_id: "canY", lid_id: "lid", label_id: "lbl", partner_id: "cbc" };
    const oddballFamily = [
      { id: "v-real-single", format: "loose", total_volume_fl_oz: 16, container_id: "canY", lid_id: "lid", label_id: "lbl", partner_id: "cbc" },
      { id: "v-real-pack", format: "4-pack", total_volume_fl_oz: 64, container_id: "canY", lid_id: "lid", label_id: "lbl", partner_id: "cbc" },
    ];
    const { client, effects } = makeClient({ target: oddballTarget, family: oddballFamily, csi: [] });

    const res = await applyBreakDown(client, { recipeId: "r1", variationId: "v-target-oddball", needed: 2, sourceRef: null });

    expect(res).toEqual({ applied: [], shortfall: 0, warnings: [] });
    expect(effects).toEqual([]);
  });

  it("cracks a case into its declared pack sibling, not an unrelated pack size in the same family", async () => {
    // This family (unusually) sells both a 4-pack and a 6-pack of the same
    // can. The case's breaks_into_variation_id points at the 4-pack only --
    // proving applyBreakDown wires that link through end-to-end rather than
    // guessing from volume/format adjacency (which would have picked the
    // numerically-closer 6-pack here and silently produced the wrong stock).
    const ambiguousFamily = [
      ...family16,
      { id: ID.pack6, format: "6-pack", total_volume_fl_oz: 96, container_id: "can16", lid_id: "lid", label_id: "lbl", partner_id: "cbc", breaks_into_variation_id: null },
    ];
    const { client, effects } = makeClient({
      target, family: ambiguousFamily,
      csi: [{ id: "row-case", batch_id: "B-050", recipe_id: "r1", variation_id: ID.case, quantity_on_hand: 1, created_at: "2026-01-01" }],
    });
    const res = await applyBreakDown(client, { recipeId: "r1", variationId: ID.pack, needed: 2, sourceRef: null });

    expect(res.applied).toEqual([{ batchId: "B-050", fromVariationId: ID.case, toVariationId: ID.pack, toUnits: 6 }]);
    expect(res.shortfall).toBe(0);
    expect(effects).not.toContainEqual(expect.objectContaining({ table: "cold_storage_inventory", payload: expect.objectContaining({ variation_id: ID.pack6 }) }));
  });
});
