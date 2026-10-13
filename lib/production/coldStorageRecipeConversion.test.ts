import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("./conversionFinalizer", () => ({
  completeConversionChild: vi.fn().mockResolvedValue(undefined),
  createConversionTargetBatch: vi.fn().mockResolvedValue("child-new"),
  findExistingConversionChild: vi.fn().mockResolvedValue(null),
  findPendingConversionPlan: vi.fn().mockResolvedValue(null),
  priorConversionInflowBbl: vi.fn().mockResolvedValue(0),
  recordExecutedConversion: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./conversionIngredients", () => ({
  consumeConversionAdditions: vi.fn().mockResolvedValue({ status: "deducted", lines: [] }),
  isChargeableConversion: vi.fn().mockResolvedValue(true),
}));
vi.mock("./commitmentFulfillment", () => ({ recheckBatchCommitments: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./triggerSquarePush", () => ({ triggerSquarePush: vi.fn().mockResolvedValue(undefined) }));

import { convertColdStorageLot, ConversionError, unitsToBbl, validateUnits } from "./coldStorageRecipeConversion";
import { createConversionTargetBatch, findExistingConversionChild, completeConversionChild, recordExecutedConversion } from "./conversionFinalizer";
import { consumeConversionAdditions, isChargeableConversion } from "./conversionIngredients";
import { recheckBatchCommitments } from "./commitmentFulfillment";
import { triggerSquarePush } from "./triggerSquarePush";

describe("unitsToBbl / validateUnits", () => {
  it("four half kegs (1984 fl oz) are 2 bbl", () => {
    expect(unitsToBbl(4, 1984)).toBe(2);
  });
  it("refuses fractions, zero and more than is there", () => {
    expect(validateUnits(0, 5)).toMatch(/whole number/);
    expect(validateUnits(1.5, 5)).toMatch(/whole number/);
    expect(validateUnits(6, 5)).toMatch(/only holds 5/);
    expect(validateUnits(5, 5)).toBeNull();
  });
});

type Rpc = { fn: string; args: Record<string, unknown> };

function stubClient(opts: { lot?: Record<string, unknown> | null; declared?: boolean; moveFails?: string } = {}) {
  const rpcs: Rpc[] = [];
  const updates: { table: string; payload: unknown }[] = [];
  let nextId = 0;
  const lot = opts.lot === undefined ? {
    id: "lot-1", batch_id: "src", recipe_id: "mule", variation_id: "half-keg", quantity_on_hand: 6,
    packaging_variations: { name: "1/2 Keg", total_volume_fl_oz: 1984, partner_id: null, is_active: true, container: { type: "keg" } },
  } : opts.lot;

  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.limit = () => Promise.resolve({ data: opts.declared ? [{ variation_id: "half-keg" }] : [], error: null });
    b.maybeSingle = () => {
      if (table === "cold_storage_inventory") return Promise.resolve({ data: lot, error: null });
      if (table === "brew_batches") return Promise.resolve({ data: { id: "src", recipe_id: "mule", batch_number: "B-056" }, error: null });
      if (table === "recipes") return Promise.resolve({ data: { beer_name: "Transfusion Lager" }, error: null });
      return Promise.resolve({ data: null, error: null });
    };
    b.update = (payload: unknown) => {
      updates.push({ table, payload });
      return { eq: () => Promise.resolve({ data: null, error: null }) };
    };
    return b;
  };
  const rpc = (fn: string, args: Record<string, unknown>) => {
    rpcs.push({ fn, args });
    if (fn === "record_batch_transfer") {
      return { single: () => Promise.resolve({ data: { id: `t-${++nextId}` }, error: null }) };
    }
    if (fn === "move_cold_storage_lot_to_batch") {
      return Promise.resolve(opts.moveFails ? { data: null, error: { message: opts.moveFails } } : { data: { id: "lot-2" }, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  };
  return { client: { from, rpc } as unknown as SupabaseClient, rpcs, updates };
}

beforeEach(() => vi.clearAllMocks());

describe("convertColdStorageLot", () => {
  it("reverses the source's packaging, converts into a new child, packages on the child, then moves the lot", async () => {
    const { client, rpcs, updates } = stubClient();
    const result = await convertColdStorageLot(client, { lotId: "lot-1", targetRecipeId: "transfusion", units: 4, note: "grape juice" });

    expect(createConversionTargetBatch).toHaveBeenCalledWith(client, expect.objectContaining({
      sourceBatchId: "src", recipeId: "transfusion", volumeBbl: 2, bornComplete: true,
    }));

    const transfers = rpcs.filter((r) => r.fn === "record_batch_transfer").map((r) => r.args);
    expect(transfers).toHaveLength(3);
    // 1. reversal on the source: negative, no tanks
    expect(transfers[0]).toMatchObject({ p_batch_id: "src", p_transfer_type: "kegging", p_volume_bbl: -2, p_quantity: -4, p_variation_id: "half-keg", p_from_tank_id: null, p_to_tank_id: null });
    // 2. conversion on the source, pointed at the child and the packaged recipe
    expect(transfers[1]).toMatchObject({ p_batch_id: "src", p_transfer_type: "conversion", p_volume_bbl: 2, p_quantity: 4 });
    expect(updates.find((u) => u.table === "batch_transfers")?.payload).toEqual({ to_batch_id: "child-new", packaged_as_recipe_id: "transfusion" });
    // 3. packaging on the child
    expect(transfers[2]).toMatchObject({ p_batch_id: "child-new", p_transfer_type: "kegging", p_volume_bbl: 2, p_quantity: 4 });

    // the lot move names the child's packaging row as the lot's provenance
    const move = rpcs.find((r) => r.fn === "move_cold_storage_lot_to_batch")!;
    expect(move.args).toEqual({ p_lot_id: "lot-1", p_units: 4, p_to_batch_id: "child-new", p_to_recipe_id: "transfusion", p_source_transfer_id: "t-3" });
    // the order of events: three ledger rows, then the move
    expect(rpcs.map((r) => r.fn)).toEqual(["record_batch_transfer", "record_batch_transfer", "record_batch_transfer", "move_cold_storage_lot_to_batch"]);

    expect(recordExecutedConversion).toHaveBeenCalledWith(client, { sourceBatchId: "src", targetBatchId: "child-new", method: "in_package" });
    // additions are charged per RUN (the conversion row's id), so a reused child's later runs still charge
    expect(consumeConversionAdditions).toHaveBeenCalledWith(client, { sourceBatchId: "src", targetBatchId: "child-new", volumeBbl: 2, runRef: "t-2" });
    expect(completeConversionChild).toHaveBeenCalledWith(client, "child-new");
    expect(recheckBatchCommitments).toHaveBeenCalledWith(client, "src");
    expect(triggerSquarePush).toHaveBeenCalledWith(client, ["mule", "transfusion"], expect.any(String));

    expect(result).toMatchObject({ childBatchId: "child-new", volumeBbl: 2, units: 4, additions: "deducted" });
  });

  it("reuses an existing child of the same source+recipe and tops up its volume", async () => {
    vi.mocked(findExistingConversionChild).mockResolvedValueOnce({ id: "child-old", volumeBbl: 1, convertedVolumeBbl: 1 });
    const { client, updates } = stubClient();
    await convertColdStorageLot(client, { lotId: "lot-1", targetRecipeId: "transfusion", units: 2 });
    expect(createConversionTargetBatch).not.toHaveBeenCalled();
    expect(updates.find((u) => u.table === "brew_batches")?.payload).toMatchObject({ volume_bbl: 1, converted_volume_bbl: 1, converted_from_batch_id: "src" });
  });

  it("writes nothing when the target is not a conversion of the lot's beer", async () => {
    vi.mocked(isChargeableConversion).mockResolvedValueOnce(false);
    const { client, rpcs } = stubClient();
    await expect(convertColdStorageLot(client, { lotId: "lot-1", targetRecipeId: "ipa", units: 1 }))
      .rejects.toMatchObject({ status: 422, message: expect.stringContaining("Based On") });
    expect(rpcs).toHaveLength(0);
  });

  it("writes nothing when asked for more than the lot holds", async () => {
    const { client, rpcs } = stubClient();
    await expect(convertColdStorageLot(client, { lotId: "lot-1", targetRecipeId: "transfusion", units: 7 }))
      .rejects.toMatchObject({ status: 422 });
    expect(rpcs).toHaveLength(0);
  });

  it("refuses a partner can that is not declared for the target beer", async () => {
    const { client, rpcs } = stubClient({
      lot: {
        id: "lot-1", batch_id: "src", recipe_id: "mule", variation_id: "p-can", quantity_on_hand: 10,
        packaging_variations: { name: "Partner 16oz case", total_volume_fl_oz: 384, partner_id: "p1", is_active: true, container: { type: "can" } },
      },
    });
    await expect(convertColdStorageLot(client, { lotId: "lot-1", targetRecipeId: "transfusion", units: 1 }))
      .rejects.toMatchObject({ status: 422, message: expect.stringContaining("not declared") });
    expect(rpcs).toHaveLength(0);
  });

  it("reports a failed lot move loudly, after the ledger rows are committed", async () => {
    const { client, rpcs, updates } = stubClient({ moveFails: "lot holds 3 unit(s), cannot convert 4" });
    const err = await convertColdStorageLot(client, { lotId: "lot-1", targetRecipeId: "transfusion", units: 4 }).catch((e) => e);
    expect(err).toBeInstanceOf(ConversionError);
    expect(err.status).toBe(500);
    expect(err.message).toMatch(/could not be moved/);
    expect(rpcs.filter((r) => r.fn === "record_batch_transfer")).toHaveLength(3);
    // the child's packaging row carries the warning
    expect(updates.filter((u) => u.table === "batch_transfers").at(-1)?.payload).toMatchObject({ notes: expect.stringContaining("NOT moved") });
    expect(completeConversionChild).not.toHaveBeenCalled();
  });
});
