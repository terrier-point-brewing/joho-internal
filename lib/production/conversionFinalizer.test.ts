import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { conversionTargetStatus, isForward, createConversionTargetBatch } from "./conversionFinalizer";

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
