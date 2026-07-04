import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { conversionTargetStatus, isForward, createConversionTargetBatch, finalizeConversion } from "./conversionFinalizer";

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

function insertStub(newId: string, parentDate: string | null) {
  const recorded: { table: string; payload: unknown }[] = [];
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.single = () => Promise.resolve({ data: table === "brew_batches" ? { planned_brew_date: parentDate } : null, error: null });
    b.insert = (payload: unknown) => {
      recorded.push({ table, payload });
      return {
        select: () => ({ single: () => Promise.resolve({ data: { id: newId }, error: null }) }),
      };
    };
    return b;
  };
  return { client: { from } as unknown as SupabaseClient, recorded };
}

describe("createConversionTargetBatch", () => {
  it("inserts a planning child linked to the parent and returns its id", async () => {
    const { client, recorded } = insertStub("child-1", "2026-05-21");
    const id = await createConversionTargetBatch(client, {
      sourceBatchId: "S", beerName: "Pumpkin Ale", recipeId: "r1", volumeBbl: 24.5,
    });
    expect(id).toBe("child-1");
    const ins = recorded.find(r => r.table === "brew_batches");
    expect(ins?.payload).toMatchObject({
      beer_name: "Pumpkin Ale", recipe_id: "r1", volume_bbl: 24.5,
      status: "planning", converted_from_batch_id: "S", converted_volume_bbl: 24.5,
      planned_brew_date: "2026-05-21",
    });
  });
});

interface Rec { table: string; op: string; payload?: unknown; match: Record<string, unknown> }

function stub(rows: {
  equipmentType?: string | null;
  targetStatus?: string | null;
  targetEntry?: { id: string; actual_start: string | null } | null;
  sourceAssignment?: { tank_id: string; equipment: { type: string | null } | null } | null;
  exhaustion?: { is_exhausted: boolean } | null;
}) {
  const recorded: Rec[] = [];
  const from = (table: string) => {
    const match: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (k: string, v: unknown) => { match[k] = v; return b; };
    b.is = (k: string, v: unknown) => { match[`${k}:is`] = v; return b; };
    b.not = () => b; b.order = () => b; b.limit = () => b;
    // update()/insert() are called before the trailing .eq()/.is() filters in
    // real chains (`.update(payload).eq(...).eq(...)`), so record a *live*
    // reference to `match` (not a spread snapshot) and only freeze it once the
    // chain actually resolves (.then, for the awaited update chains) or
    // immediately for insert (which has no trailing filters here).
    b.update = (payload: unknown) => { recorded.push({ table, op: "update", payload, match }); return b; };
    b.insert = (payload: unknown) => { recorded.push({ table, op: "insert", payload, match: { ...match } }); return Promise.resolve({ data: null, error: null }); };
    b.maybeSingle = () => read(table);
    b.single = () => read(table);
    b.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null }); // update().eq()... await
    return b;
  };
  const read = (table: string) => {
    if (table === "equipment") return Promise.resolve({ data: { type: rows.equipmentType ?? null }, error: null });
    if (table === "batch_exhaustion") return Promise.resolve({ data: rows.exhaustion ?? null, error: null });
    if (table === "brew_batches") return Promise.resolve({ data: { status: rows.targetStatus ?? null }, error: null });
    if (table === "batch_schedule_entries") return Promise.resolve({ data: rows.targetEntry ?? null, error: null });
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
});
