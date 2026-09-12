import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/square/projects", () => ({
  createBatchSquareProject: vi.fn().mockResolvedValue(null),
}));

import { createBatchSquareProject } from "@/lib/square/projects";
import { conversionTargetStatus, isForward, createConversionTargetBatch, deriveConversionDeliveryDate, findPendingConversionPlan, finalizeConversion, reconcileConvertedBatchVolume, seedConversionChildSchedule, CONVERSION_PLAN_SCHEDULE_NOTE } from "./conversionFinalizer";

describe("conversionTargetStatus", () => {
  it("maps brite → conditioning and fermenter → fermenting", () => {
    expect(conversionTargetStatus("brite")).toBe("conditioning");
    expect(conversionTargetStatus("fermenter")).toBe("fermenting");
  });
  it("returns null for unconstrained / unknown dest types", () => {
    expect(conversionTargetStatus("kegging")).toBeNull();
    expect(conversionTargetStatus(null)).toBeNull();
    expect(conversionTargetStatus(undefined)).toBeNull();
  });
});

describe("isForward", () => {
  it("advances planning → conditioning", () => {
    expect(isForward("planning", "conditioning")).toBe(true);
  });
  it("does not regress conditioning → fermenting", () => {
    expect(isForward("conditioning", "fermenting")).toBe(false);
  });
  it("treats null/unknown current status as earliest, and never advances past complete", () => {
    expect(isForward(null, "fermenting")).toBe(true);
    expect(isForward("complete", "conditioning")).toBe(false);
  });
});

function insertStub(newId: string, opts?: {
  briteDays?: number | null;
  activityTemplates?: Array<Record<string, unknown>>;
}) {
  const recorded: { table: string; payload: unknown }[] = [];
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.order = () => {
      // brew_activities template read: `.select().eq().order()` awaited directly.
      return Promise.resolve({ data: opts?.activityTemplates ?? [], error: null });
    };
    b.maybeSingle = () => Promise.resolve({
      data: table === "recipes" ? { days_brite: opts?.briteDays ?? null } : null,
      error: null,
    });
    b.single = () => Promise.resolve({ data: null, error: null });
    b.insert = (payload: unknown) => {
      recorded.push({ table, payload });
      return {
        select: () => ({ single: () => Promise.resolve({ data: { id: newId }, error: null }) }),
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
      };
    };
    return b;
  };
  return { client: { from } as unknown as SupabaseClient, recorded };
}

describe("deriveConversionDeliveryDate", () => {
  it("adds the recipe's brite days to the conversion date", async () => {
    const { client } = insertStub("x", { briteDays: 14 });
    expect(await deriveConversionDeliveryDate(client, "r1", "2026-05-01")).toBe("2026-05-15");
  });
  it("falls back to the conversion date itself when the recipe declares no brite time", async () => {
    const { client } = insertStub("x", { briteDays: null });
    expect(await deriveConversionDeliveryDate(client, "r1", "2026-05-01")).toBe("2026-05-01");
  });
});

describe("createConversionTargetBatch", () => {
  it("inserts a planning child dated at the CONVERSION day with a derived delivery date", async () => {
    const { client, recorded } = insertStub("child-1", { briteDays: 10 });
    const id = await createConversionTargetBatch(client, {
      sourceBatchId: "S", beerName: "Pumpkin Ale", recipeId: "r1", volumeBbl: 24.5,
      conversionDate: "2026-07-30",
    });
    expect(id).toBe("child-1");
    const ins = recorded.find(r => r.table === "brew_batches");
    expect(ins?.payload).toMatchObject({
      beer_name: "Pumpkin Ale", recipe_id: "r1", volume_bbl: 24.5,
      status: "planning", converted_from_batch_id: "S", converted_volume_bbl: 24.5,
      planned_brew_date: "2026-07-30",
      expected_delivery_date: "2026-08-09",
    });
  });

  it("logs the initial status and seeds activities from the recipe's templates", async () => {
    const { client, recorded } = insertStub("child-2", {
      briteDays: 0,
      activityTemplates: [{ sort_order: 0, activity: "Add puree", time_label: null, temp: null, amount: 40, amount_unit: "lb" }],
    });
    await createConversionTargetBatch(client, {
      sourceBatchId: "S", beerName: "Orange Pilsner", recipeId: "r2", volumeBbl: 5,
      conversionDate: "2026-08-04",
    });
    const history = recorded.find(r => r.table === "batch_status_history");
    expect(history?.payload).toMatchObject({ batch_id: "child-2", status: "planning" });
    const activities = recorded.find(r => r.table === "brew_activities");
    expect(activities?.payload).toMatchObject([{ batch_id: "child-2", activity: "Add puree", amount: 40 }]);
  });

  it("creates the Square project for a plan/tank child but never for one born complete", async () => {
    vi.mocked(createBatchSquareProject).mockClear();
    const a = insertStub("child-3", { briteDays: 5 });
    await createConversionTargetBatch(a.client, {
      sourceBatchId: "S", beerName: "Mule", recipeId: "r3", volumeBbl: 24, conversionDate: "2026-07-30",
    });
    expect(createBatchSquareProject).toHaveBeenCalledWith(a.client, expect.objectContaining({
      batchId: "child-3", plannedBrewDate: "2026-07-30", expectedDeliveryDate: "2026-08-04",
    }));

    vi.mocked(createBatchSquareProject).mockClear();
    const b = insertStub("child-4", { briteDays: 5 });
    await createConversionTargetBatch(b.client, {
      sourceBatchId: "S", beerName: "Mule", recipeId: "r3", volumeBbl: 0.5,
      conversionDate: "2026-07-30", bornComplete: true,
    });
    expect(createBatchSquareProject).not.toHaveBeenCalled();
  });
});

describe("seedConversionChildSchedule", () => {
  function scheduleStub(briteDays: number | null) {
    const recorded: Array<{ op: string; payload?: unknown }> = [];
    const from = (table: string) => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.is = () => b;
      b.maybeSingle = () => Promise.resolve({ data: table === "recipes" ? { days_brite: briteDays } : null, error: null });
      b.delete = () => { recorded.push({ op: "delete" }); return b; };
      b.insert = (payload: unknown) => { recorded.push({ op: "insert", payload }); return Promise.resolve({ data: null, error: null }); };
      b.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
      return b;
    };
    return { client: { from } as unknown as SupabaseClient, recorded };
  }

  it("replaces marker ghosts with conditioning + the 70/30 packaging split on plan dates", async () => {
    const { client, recorded } = scheduleStub(7);
    await seedConversionChildSchedule(client, {
      childBatchId: "child", recipeId: "r1", volumeBbl: 24, conversionDate: "2026-07-30",
    });
    expect(recorded[0]).toEqual({ op: "delete" });
    const inserted = recorded[1].payload as Array<Record<string, unknown>>;
    expect(inserted).toEqual([
      expect.objectContaining({ stage: "conditioning", planned_start: "2026-07-30", planned_end: "2026-08-06", volume_bbl: 24, notes: CONVERSION_PLAN_SCHEDULE_NOTE }),
      expect.objectContaining({ stage: "kegging", planned_start: "2026-08-06", volume_bbl: 16.8, notes: CONVERSION_PLAN_SCHEDULE_NOTE }),
      expect.objectContaining({ stage: "canning", planned_start: "2026-08-06", volume_bbl: 7.2, notes: CONVERSION_PLAN_SCHEDULE_NOTE }),
    ]);
  });

  it("collapses conditioning to a same-day span when the recipe has no brite time", async () => {
    const { client, recorded } = scheduleStub(null);
    await seedConversionChildSchedule(client, {
      childBatchId: "child", recipeId: "r1", volumeBbl: 1, conversionDate: "2026-09-12",
    });
    const inserted = recorded[1].payload as Array<Record<string, unknown>>;
    expect(inserted[0]).toEqual(expect.objectContaining({ planned_start: "2026-09-12", planned_end: "2026-09-12" }));
    expect(inserted[1]).toEqual(expect.objectContaining({ volume_bbl: 0.7 }));
    expect(inserted[2]).toEqual(expect.objectContaining({ volume_bbl: 0.3 }));
  });
});

describe("findPendingConversionPlan", () => {
  function planStub(plans: Array<{ id: string; target_batch_id: string; target: { recipe_id: string | null; status: string | null } | null }>) {
    const from = () => {
      const b: Record<string, unknown> = {};
      b.select = () => b; b.eq = () => b; b.is = () => b;
      b.order = () => Promise.resolve({ data: plans, error: null });
      return b;
    };
    return { from } as unknown as SupabaseClient;
  }

  it("returns the oldest pending plan whose waiting child matches the recipe", async () => {
    const client = planStub([
      { id: "p1", target_batch_id: "t1", target: { recipe_id: "other", status: "planning" } },
      { id: "p2", target_batch_id: "t2", target: { recipe_id: "r1", status: "planning" } },
      { id: "p3", target_batch_id: "t3", target: { recipe_id: "r1", status: "planning" } },
    ]);
    expect(await findPendingConversionPlan(client, { sourceBatchId: "S", recipeId: "r1" }))
      .toEqual({ planId: "p2", targetBatchId: "t2" });
  });

  it("skips targets that already left planning/backlog, and misses cleanly", async () => {
    const client = planStub([
      { id: "p1", target_batch_id: "t1", target: { recipe_id: "r1", status: "conditioning" } },
    ]);
    expect(await findPendingConversionPlan(client, { sourceBatchId: "S", recipeId: "r1" })).toBeNull();
  });
});

interface Rec { table: string; op: string; payload?: unknown; match: Record<string, unknown> }

function stub(rows: {
  equipmentType?: string | null;
  targetStatus?: string | null;
  targetEntry?: { id: string; actual_start: string | null } | null;
  sourceAssignment?: { tank_id: string; equipment: { type: string | null } | null } | null;
  sourceEntry?: { stage: string } | null;
  exhaustion?: { is_exhausted: boolean } | null;
}) {
  const recorded: Rec[] = [];
  const from = (table: string) => {
    const match: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    let isSourceEntryRead = false;
    b.select = (cols: string) => { if (table === "batch_schedule_entries" && cols.includes("stage")) isSourceEntryRead = true; return b; };
    b.eq = (k: string, v: unknown) => { match[k] = v; return b; };
    b.is = (k: string, v: unknown) => { match[`${k}:is`] = v; return b; };
    b.not = () => b; b.order = () => b; b.limit = () => b; b.in = () => b;
    // update()/insert() are called before the trailing .eq()/.is() filters in
    // real chains (`.update(payload).eq(...).eq(...)`), so record a *live*
    // reference to `match` (not a spread snapshot) and only freeze it once the
    // chain actually resolves (.then, for the awaited update chains) or
    // immediately for insert (which has no trailing filters here).
    b.update = (payload: unknown) => { recorded.push({ table, op: "update", payload, match }); return b; };
    b.insert = (payload: unknown) => { recorded.push({ table, op: "insert", payload, match: { ...match } }); return Promise.resolve({ data: null, error: null }); };
    b.maybeSingle = () => read(table, isSourceEntryRead);
    b.single = () => read(table, isSourceEntryRead);
    b.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null }); // update().eq()... await
    return b;
  };
  const read = (table: string, isSourceEntryRead: boolean) => {
    if (table === "equipment") return Promise.resolve({ data: { type: rows.equipmentType ?? null }, error: null });
    if (table === "batch_exhaustion") return Promise.resolve({ data: rows.exhaustion ?? null, error: null });
    if (table === "brew_batches") return Promise.resolve({ data: { status: rows.targetStatus ?? null }, error: null });
    if (table === "batch_schedule_entries") {
      return Promise.resolve({ data: isSourceEntryRead ? (rows.sourceEntry ?? null) : (rows.targetEntry ?? null), error: null });
    }
    if (table === "batch_tank_assignments") return Promise.resolve({ data: rows.sourceAssignment ?? null, error: null });
    return Promise.resolve({ data: null, error: null });
  };
  return { client: { from } as unknown as SupabaseClient, recorded };
}

describe("finalizeConversion", () => {
  const base = { sourceBatchId: "S", targetBatchId: "T", fromTankId: "src", toTankId: "dst", volumeBbl: 24.5, today: "2026-07-03" };

  it("releases source from dest tank and assigns target there", async () => {
    const { client, recorded } = stub({ equipmentType: "brite", targetStatus: "planning", exhaustion: { is_exhausted: true } });
    await finalizeConversion(client, base);
    expect(recorded.find(r => r.table === "batch_tank_assignments" && r.op === "update" && r.match["batch_id"] === "S" && r.match["tank_id"] === "dst")).toBeTruthy();
    expect(recorded.find(r => r.table === "batch_tank_assignments" && r.op === "insert")?.payload).toEqual({ batch_id: "T", tank_id: "dst" });
  });

  it("advances target planning → conditioning with a history row", async () => {
    const { client, recorded } = stub({ equipmentType: "brite", targetStatus: "planning", exhaustion: { is_exhausted: true } });
    await finalizeConversion(client, base);
    expect(recorded.find(r => r.table === "brew_batches" && r.op === "update" && r.match["id"] === "T")?.payload).toEqual({ status: "conditioning" });
    expect(recorded.find(r => r.table === "batch_status_history")).toBeTruthy();
  });

  it("cancels the source's spurious dest-tank schedule entry", async () => {
    const { client, recorded } = stub({ equipmentType: "brite", targetStatus: "planning", exhaustion: { is_exhausted: true } });
    await finalizeConversion(client, base);
    expect(recorded.find(r => r.table === "batch_schedule_entries" && r.op === "update" && r.match["batch_id"] === "S" && r.match["equipment_id"] === "dst")).toBeTruthy();
  });

  it("stamps an existing target schedule entry instead of inserting one", async () => {
    const { client, recorded } = stub({ equipmentType: "brite", targetStatus: "planning", targetEntry: { id: "e5", actual_start: null }, exhaustion: { is_exhausted: true } });
    await finalizeConversion(client, base);
    expect((recorded.find(r => r.table === "batch_schedule_entries" && r.op === "update" && r.match["id"] === "e5")?.payload as { volume_bbl: number }).volume_bbl).toBe(24.5);
    expect(recorded.find(r => r.table === "batch_schedule_entries" && r.op === "insert")).toBeUndefined();
  });

  it("does nothing to the dest tank when toTankId is null", async () => {
    const { client, recorded } = stub({ equipmentType: null, exhaustion: { is_exhausted: false } });
    await finalizeConversion(client, { ...base, toTankId: null });
    expect(recorded.find(r => r.table === "batch_tank_assignments" && r.op === "insert")).toBeUndefined();
  });

  it("sets source status from its open schedule entry stage, not tank type (fermenter hosting conditioning, partial conversion)", async () => {
    const { client, recorded } = stub({
      equipmentType: "brite", targetStatus: "planning",
      sourceAssignment: { tank_id: "src", equipment: { type: "fermenter" } },
      sourceEntry: { stage: "conditioning" },
      exhaustion: { is_exhausted: false },
    });
    await finalizeConversion(client, base);
    const srcUpd = recorded.find(r => r.table === "brew_batches" && r.op === "update" && r.match["id"] === "S");
    expect(srcUpd?.payload).toEqual({ status: "conditioning" });
  });
});

function reconcileStub(cfg: {
  batch: { volume_bbl: number | null; converted_volume_bbl: number | null; recipe_id: string | null; turns?: number | null } | null;
  inflows: { volume_bbl: number }[];
  commitmentCount?: number;
  recipeIngredients?: { ingredient_id: string; quantity_per_turn: number }[];
}) {
  const recorded: { table: string; op: string; payload?: unknown; match: Record<string, unknown> }[] = [];
  const from = (table: string) => {
    const match: Record<string, unknown> = {};
    let headCount = false;
    const b: Record<string, unknown> = {};
    b.select = (_cols: string, opts?: { count?: string; head?: boolean }) => { if (opts?.head) headCount = true; return b; };
    b.eq = (k: string, v: unknown) => { match[k] = v; return b; };
    // upsertCommitments follows its upsert with a prune chain
    // (.update().eq().is().not()) that releases ingredients no longer in the
    // recipe; both filters have to be chainable for that call to resolve.
    b.is = (k: string, v: unknown) => { match[`${k}:is`] = v; return b; };
    b.not = (k: string, op: string, v: unknown) => { match[`${k}:not:${op}`] = v; return b; };
    b.update = (payload: unknown) => { recorded.push({ table, op: "update", payload, match }); return b; };
    b.upsert = (payload: unknown) => { recorded.push({ table, op: "upsert", payload, match: { ...match } }); return Promise.resolve({ data: null, error: null }); };
    b.single = () => Promise.resolve({ data: table === "brew_batches" ? cfg.batch : null, error: null });
    // Awaited list/void chains resolve here: batch_transfers → inflows, the count
    // query → { count }, recipe_ingredients → rows, brew_batches update → null.
    b.then = (resolve: (v: unknown) => void) => {
      if (table === "batch_transfers") return resolve({ data: cfg.inflows, error: null });
      if (table === "batch_ingredient_commitments" && headCount) return resolve({ count: cfg.commitmentCount ?? 0, data: null, error: null });
      if (table === "recipe_ingredients") return resolve({ data: cfg.recipeIngredients ?? [], error: null });
      return resolve({ data: null, error: null });
    };
    return b;
  };
  return { client: { from } as unknown as SupabaseClient, recorded };
}

describe("reconcileConvertedBatchVolume", () => {
  it("reconciles a pre-planned target down to the delivered volume (planned − shrinkage)", async () => {
    const { client, recorded } = reconcileStub({
      batch: { volume_bbl: 25, converted_volume_bbl: 25, recipe_id: "r1" },
      inflows: [{ volume_bbl: 24.5 }],
      commitmentCount: 0,
    });
    await reconcileConvertedBatchVolume(client, "T");
    const upd = recorded.find(r => r.table === "brew_batches" && r.op === "update");
    expect(upd?.payload).toEqual({ volume_bbl: 24.5, converted_volume_bbl: 24.5 });
    // No commitments on the batch → never fabricate them.
    expect(recorded.find(r => r.table === "batch_ingredient_commitments" && r.op === "upsert")).toBeUndefined();
  });

  it("no-ops for the inline path already born at the delivered volume", async () => {
    const { client, recorded } = reconcileStub({
      batch: { volume_bbl: 24.5, converted_volume_bbl: 24.5, recipe_id: "r1" },
      inflows: [{ volume_bbl: 24.5 }],
    });
    await reconcileConvertedBatchVolume(client, "T");
    expect(recorded.find(r => r.table === "brew_batches" && r.op === "update")).toBeUndefined();
  });

  it("leaves a blended-into-existing target untouched (volume_bbl ≠ converted_volume_bbl)", async () => {
    const { client, recorded } = reconcileStub({
      batch: { volume_bbl: 30, converted_volume_bbl: 5, recipe_id: "r1" },
      inflows: [{ volume_bbl: 5 }],
    });
    await reconcileConvertedBatchVolume(client, "T");
    expect(recorded.find(r => r.table === "brew_batches" && r.op === "update")).toBeUndefined();
  });

  it("sums multiple conversion inflows for a multi-source target", async () => {
    const { client, recorded } = reconcileStub({
      batch: { volume_bbl: 25, converted_volume_bbl: 25, recipe_id: "r1" },
      inflows: [{ volume_bbl: 15 }, { volume_bbl: 9.5 }],
      commitmentCount: 0,
    });
    await reconcileConvertedBatchVolume(client, "T");
    const upd = recorded.find(r => r.table === "brew_batches" && r.op === "update");
    expect(upd?.payload).toEqual({ volume_bbl: 24.5, converted_volume_bbl: 24.5 });
  });

  // Re-syncs against the current recipe when the batch already holds
  // commitments — at its own turn count, NOT scaled to the delivered liquid.
  // Reconciling volume that arrived from another vessel changes how much beer
  // the target holds, never how much grain its turns consumed.
  it("re-syncs commitments at the batch's turn count only when it already has them", async () => {
    const { client, recorded } = reconcileStub({
      batch: { volume_bbl: 25, converted_volume_bbl: 25, recipe_id: "r1", turns: 2 },
      inflows: [{ volume_bbl: 24.5 }],
      commitmentCount: 3,
      recipeIngredients: [{ ingredient_id: "i1", quantity_per_turn: 2 }],
    });
    await reconcileConvertedBatchVolume(client, "T");
    const ups = recorded.find(r => r.table === "batch_ingredient_commitments" && r.op === "upsert");
    expect(ups).toBeTruthy();
    expect((ups?.payload as { committed_qty: number }[])[0]).toMatchObject({ batch_id: "T", ingredient_id: "i1", committed_qty: 4 });
  });
});
