// lib/production/conversionIngredients.test.ts
//
// What a conversion charges to stock. The rule under test is narrow and
// load-bearing: deduct the derived recipe's additions, scaled to the volume
// actually drawn off, and ONLY when the target's recipe names this source's
// recipe as its base. Every other path must leave stock alone — an unlinked
// pair, a clone with no delta, a second run over the same conversion.
//
// The stub returns fixed rows and records the writes, so the assertions are on
// the real computed quantities (79.9 lb of puree, not "insert was called").
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  consumeConversionAdditions,
  consumePackagedConversionAdditions,
  resolveConversionBase,
  CONVERSION_ADDITION_NOTE,
} from "./conversionIngredients";

interface StubConfig {
  sourceRecipeId?: string | null;
  targetRecipeId?: string | null;
  baseRecipeId?: string | null;
  /**
   * The whole recipes table's lineage, as the resolver reads it. Defaults to a
   * one-hop chain built from the ids above; set it explicitly to test a chain.
   */
  lineage?: Array<{ id: string; base_recipe_id: string | null }>;
  derivedBill?: Array<{ ingredient_id: string; quantity_per_bbl: number; ingredients?: { cost_per_unit_usd: number | null; unit: string | null } }>;
  baseBill?: Array<{ ingredient_id: string; quantity_per_bbl: number }>;
  /** Bills keyed by recipe id — needed once a chain means "the base" varies. */
  bills?: Record<string, Array<{ ingredient_id: string; quantity_per_bbl: number; ingredients?: { cost_per_unit_usd: number | null; unit: string | null } }>>;
  alreadyBooked?: boolean;
  insertFails?: boolean;
}

interface Recorded { table: string; op: string; payload: unknown }

// Carolina Brown Ale → Reaper's Harvest at a 20 bbl expected yield: the bills
// are identical but for 68 lb of pumpkin puree per turn, i.e. 3.4 lb per bbl.
const BASE_BILL = [
  { ingredient_id: "silo", quantity_per_bbl: 725 / 20 },
  { ingredient_id: "ctz", quantity_per_bbl: 1.63 / 20 },
];
const DERIVED_BILL = [
  ...BASE_BILL.map((l) => ({ ...l, ingredients: { cost_per_unit_usd: 0.42, unit: "lbs" } })),
  { ingredient_id: "puree", quantity_per_bbl: 68 / 20, ingredients: { cost_per_unit_usd: 2.5, unit: "lbs" } },
];

function stub(cfg: StubConfig) {
  const recorded: Recorded[] = [];
  const rpcCalls: Array<{ p_id: string; p_delta: number }> = [];

  // The resolver reads lineage from the whole recipes table and walks it, so the
  // stub serves rows rather than answering one id at a time.
  const lineage = cfg.lineage ?? [
    ...(cfg.targetRecipeId ? [{ id: cfg.targetRecipeId, base_recipe_id: cfg.baseRecipeId ?? null }] : []),
    ...(cfg.baseRecipeId ? [{ id: cfg.baseRecipeId, base_recipe_id: null }] : []),
    ...(cfg.sourceRecipeId && cfg.sourceRecipeId !== cfg.baseRecipeId
      ? [{ id: cfg.sourceRecipeId, base_recipe_id: null }]
      : []),
  ];

  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    let recipeFilter: string | null = null;

    b.select = () =>
      table === "recipes" ? Promise.resolve({ data: lineage, error: null }) : b;
    b.limit = () =>
      Promise.resolve({ data: cfg.alreadyBooked ? [{ id: "existing" }] : [], error: null });
    b.like = () => b;
    b.is = () => Promise.resolve({ error: null });
    b.update = (p: unknown) => { recorded.push({ table, op: "update", payload: p }); return b; };
    b.insert = (p: unknown) => {
      recorded.push({ table, op: "insert", payload: p });
      return Promise.resolve({ error: cfg.insertFails ? { message: "boom" } : null });
    };
    b.maybeSingle = () => {
      if (table === "brew_batches") {
        // Distinguished by the id the caller filtered on.
        return Promise.resolve({
          data: recipeFilter === "src-batch"
            ? { recipe_id: cfg.sourceRecipeId ?? null }
            : { recipe_id: cfg.targetRecipeId ?? null, batch_number: "B-038", beer_name: "Pumpkin Ale" },
          error: null,
        });
      }
      return Promise.resolve({ data: { base_recipe_id: cfg.baseRecipeId ?? null }, error: null });
    };
    b.eq = (_col: string, val: string) => {
      recipeFilter = val;
      // recipe_ingredients terminates at .eq(); everything else keeps chaining.
      if (table === "recipe_ingredients") {
        return Promise.resolve({
          data: cfg.bills?.[val]
            ?? (val === cfg.baseRecipeId ? (cfg.baseBill ?? BASE_BILL) : (cfg.derivedBill ?? DERIVED_BILL)),
          error: null,
        });
      }
      return b;
    };
    return b;
  };

  const client = {
    from,
    rpc: (_name: string, args: { p_id: string; p_delta: number }) => {
      rpcCalls.push(args);
      return Promise.resolve({ error: null });
    },
  } as unknown as SupabaseClient;

  return { client, recorded, rpcCalls };
}

const LINKED: StubConfig = {
  sourceRecipeId: "brown-ale",
  targetRecipeId: "reapers",
  baseRecipeId: "brown-ale",
};

describe("resolveConversionBase", () => {
  it("resolves when the target's recipe names this source's recipe", async () => {
    const { client } = stub(LINKED);
    await expect(resolveConversionBase(client, "src-batch", "tgt-batch")).resolves.toEqual({
      derivedRecipeId: "reapers",
      baseRecipeId: "brown-ale",
    });
  });

  it("returns null when the target's recipe is based on a DIFFERENT beer", async () => {
    // Reaper's Harvest is based on Carolina Brown Ale; converting Wheat Wave into
    // it says nothing about which of its lines the wheat batch already paid for.
    const { client } = stub({ ...LINKED, sourceRecipeId: "wheat-wave" });
    await expect(resolveConversionBase(client, "src-batch", "tgt-batch")).resolves.toBeNull();
  });

  it("returns null when the target's recipe declares no base", async () => {
    const { client } = stub({ ...LINKED, baseRecipeId: null });
    await expect(resolveConversionBase(client, "src-batch", "tgt-batch")).resolves.toBeNull();
  });

  it("returns null when either batch carries no recipe", async () => {
    const { client } = stub({ ...LINKED, targetRecipeId: null });
    await expect(resolveConversionBase(client, "src-batch", "tgt-batch")).resolves.toBeNull();
  });
});

describe("consumeConversionAdditions", () => {
  it("deducts only the addition, scaled to the volume converted", async () => {
    const { client, recorded, rpcCalls } = stub(LINKED);
    const result = await consumeConversionAdditions(client, {
      sourceBatchId: "src-batch", targetBatchId: "tgt-batch", volumeBbl: 23.5,
    });

    expect(result.status).toBe("deducted");
    const insert = recorded.find((r) => r.table === "stock_adjustments" && r.op === "insert");
    const rows = insert!.payload as Array<Record<string, unknown>>;
    // The base's malt and hops came with the liquid — one line, not three.
    expect(rows).toHaveLength(1);
    expect(rows[0].ingredient_id).toBe("puree");
    // 68 lb per 20 bbl turn = 3.4 lb/bbl; 23.5 bbl of it is 79.9 lb, deducted.
    expect(rows[0].quantity as number).toBeCloseTo(-79.9, 6);
    expect(rows[0].type).toBe("batch_use");
    expect(rows[0].batch_id).toBe("tgt-batch");
    expect(rows[0].unit).toBe("lbs");
    expect(rows[0].total_value_change_usd as number).toBeCloseTo(-79.9 * 2.5, 6);
    expect(String(rows[0].note)).toContain(CONVERSION_ADDITION_NOTE);

    // Stock itself moves by the same signed amount.
    expect(rpcCalls).toEqual([{ p_id: "puree", p_delta: rows[0].quantity }]);
  });

  it("releases the target's commitments once the stock has moved", async () => {
    const { client, recorded } = stub(LINKED);
    await consumeConversionAdditions(client, {
      sourceBatchId: "src-batch", targetBatchId: "tgt-batch", volumeBbl: 10,
    });
    const release = recorded.find((r) => r.table === "batch_ingredient_commitments" && r.op === "update");
    expect((release!.payload as { released_at: string }).released_at).toBeTruthy();
  });

  it("touches nothing when the recipes are not linked", async () => {
    const { client, recorded, rpcCalls } = stub({ ...LINKED, baseRecipeId: null });
    const result = await consumeConversionAdditions(client, {
      sourceBatchId: "src-batch", targetBatchId: "tgt-batch", volumeBbl: 23.5,
    });
    expect(result.status).toBe("unlinked");
    expect(recorded).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });

  it("touches nothing when the derived bill adds nothing to the base", async () => {
    // Coffee Epic today: an exact copy of Epic Hazy IPA, the coffee never entered.
    const { client, recorded, rpcCalls } = stub({
      ...LINKED,
      derivedBill: BASE_BILL.map((l) => ({ ...l, ingredients: { cost_per_unit_usd: 1, unit: "lbs" } })),
    });
    const result = await consumeConversionAdditions(client, {
      sourceBatchId: "src-batch", targetBatchId: "tgt-batch", volumeBbl: 23.5,
    });
    expect(result.status).toBe("no_additions");
    expect(recorded).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });

  it("does not charge twice when the conversion is re-run", async () => {
    const { client, recorded, rpcCalls } = stub({ ...LINKED, alreadyBooked: true });
    const result = await consumeConversionAdditions(client, {
      sourceBatchId: "src-batch", targetBatchId: "tgt-batch", volumeBbl: 23.5,
    });
    expect(result.status).toBe("already_booked");
    expect(recorded).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });

  it("does not move stock when the ledger row could not be written", async () => {
    // The adjustment row is the record AND the replay guard. Without it, the RPC
    // would decrement stock that nothing accounts for and a retry would do it again.
    const { client, rpcCalls } = stub({ ...LINKED, insertFails: true });
    const result = await consumeConversionAdditions(client, {
      sourceBatchId: "src-batch", targetBatchId: "tgt-batch", volumeBbl: 23.5,
    });
    expect(result.status).toBe("not_applicable");
    expect(rpcCalls).toEqual([]);
  });

  it("ignores a conversion with no volume", async () => {
    const { client, recorded } = stub(LINKED);
    for (const volumeBbl of [0, -5, Number.NaN]) {
      const result = await consumeConversionAdditions(client, {
        sourceBatchId: "src-batch", targetBatchId: "tgt-batch", volumeBbl,
      });
      expect(result.status).toBe("not_applicable");
    }
    expect(recorded).toEqual([]);
  });

  it("carries a null cost through rather than valuing the movement at zero", async () => {
    const { client, recorded } = stub({
      ...LINKED,
      derivedBill: [
        ...BASE_BILL.map((l) => ({ ...l, ingredients: { cost_per_unit_usd: 1, unit: "lbs" } })),
        { ingredient_id: "puree", quantity_per_bbl: 3.4, ingredients: { cost_per_unit_usd: null, unit: "lbs" } },
      ],
    });
    await consumeConversionAdditions(client, {
      sourceBatchId: "src-batch", targetBatchId: "tgt-batch", volumeBbl: 10,
    });
    const rows = recorded.find((r) => r.op === "insert")!.payload as Array<Record<string, unknown>>;
    expect(rows[0].cost_per_unit_usd).toBeNull();
    expect(rows[0].total_value_change_usd).toBeNull();
  });
});

// Pace Yourself Pilsner → Carolina Mule → Transfusion Lager. Each step only
// adds, so the same subtraction answers every hop of the chain.
const PILSNER_BILL = [
  { ingredient_id: "silo", quantity_per_bbl: 34.75 },
  { ingredient_id: "pils-malt", quantity_per_bbl: 16.5 },
];
const MULE_BILL = [
  ...PILSNER_BILL,
  { ingredient_id: "ginger", quantity_per_bbl: 6.6 },
  { ingredient_id: "lime", quantity_per_bbl: 6.6 },
];
const TRANSFUSION_BILL = [
  ...MULE_BILL,
  { ingredient_id: "grape", quantity_per_bbl: 0.1 },
];
const priced = (bill: Array<{ ingredient_id: string; quantity_per_bbl: number }>) =>
  bill.map((l) => ({ ...l, ingredients: { cost_per_unit_usd: 1, unit: "lbs" } }));

const CHAIN: StubConfig = {
  lineage: [
    { id: "transfusion", base_recipe_id: "mule" },
    { id: "mule", base_recipe_id: "pilsner" },
    { id: "pilsner", base_recipe_id: null },
  ],
};

describe("a chained conversion", () => {
  it("charges one hop's addition when drawn off the middle of the chain", async () => {
    // Mule in the tank, Transfusion in the target: the ginger and lime are
    // already dissolved in the liquid, so only the grape juice is new stock.
    const { client, recorded } = stub({
      ...CHAIN,
      sourceRecipeId: "mule", targetRecipeId: "transfusion", baseRecipeId: "mule",
      bills: { transfusion: priced(TRANSFUSION_BILL), mule: MULE_BILL, pilsner: PILSNER_BILL },
    });
    const result = await consumeConversionAdditions(client, {
      sourceBatchId: "src-batch", targetBatchId: "tgt-batch", volumeBbl: 20,
    });

    expect(result.status).toBe("deducted");
    const rows = recorded.find((r) => r.table === "stock_adjustments")!.payload as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.ingredient_id)).toEqual(["grape"]);
    expect(rows[0].quantity as number).toBeCloseTo(-2, 6);
  });

  it("charges BOTH hops when the chain is skipped and it is drawn off the root", async () => {
    // Straight from a Pilsner batch to Transfusion Lager. Nothing but the base
    // malt came with the liquid, so ginger, lime and grape are all new stock —
    // which is the same subtraction, against a different bill.
    const { client, recorded } = stub({
      ...CHAIN,
      sourceRecipeId: "pilsner", targetRecipeId: "transfusion", baseRecipeId: "mule",
      bills: { transfusion: priced(TRANSFUSION_BILL), mule: MULE_BILL, pilsner: PILSNER_BILL },
    });
    const result = await consumeConversionAdditions(client, {
      sourceBatchId: "src-batch", targetBatchId: "tgt-batch", volumeBbl: 20,
    });

    expect(result.status).toBe("deducted");
    const rows = recorded.find((r) => r.table === "stock_adjustments")!.payload as Array<Record<string, unknown>>;
    expect(new Set(rows.map((r) => r.ingredient_id))).toEqual(new Set(["ginger", "lime", "grape"]));
  });

  it("still refuses a source that is nowhere in the target's chain", async () => {
    const { client } = stub({
      ...CHAIN,
      sourceRecipeId: "transfusion", targetRecipeId: "mule", baseRecipeId: "pilsner",
    });
    // Converting the finished Transfusion back into Mule is not a conversion —
    // the chain only runs one way, and nothing can un-add grape juice.
    await expect(resolveConversionBase(client, "src-batch", "tgt-batch")).resolves.toBeNull();
  });
});

describe("consumePackagedConversionAdditions", () => {
  const IN_KEG: StubConfig = {
    ...CHAIN,
    sourceRecipeId: "mule",
    bills: { transfusion: priced(TRANSFUSION_BILL), mule: MULE_BILL, pilsner: PILSNER_BILL },
  };

  it("charges the dose against the batch it was kegged out of", async () => {
    const { client, recorded, rpcCalls } = stub(IN_KEG);
    const result = await consumePackagedConversionAdditions(client, {
      sourceBatchId: "src-batch", transferId: "xfer-1",
      packagedRecipeId: "transfusion", volumeBbl: 20,
    });

    expect(result.status).toBe("deducted");
    const rows = recorded.find((r) => r.table === "stock_adjustments")!.payload as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.ingredient_id)).toEqual(["grape"]);
    // Filed against the SOURCE batch — the beer it physically came out of. There
    // is no other batch; that is the whole point of an in-keg conversion.
    expect(rows[0].batch_id).toBe("src-batch");
    // Keyed to this run, so kegging the same batch again is a second charge.
    expect(String(rows[0].note)).toContain("xfer-1");
    expect(rpcCalls).toEqual([{ p_id: "grape", p_delta: rows[0].quantity }]);
  });

  it("does not charge the run twice when it is retried", async () => {
    const { client, recorded, rpcCalls } = stub({ ...IN_KEG, alreadyBooked: true });
    const result = await consumePackagedConversionAdditions(client, {
      sourceBatchId: "src-batch", transferId: "xfer-1",
      packagedRecipeId: "transfusion", volumeBbl: 20,
    });
    expect(result.status).toBe("already_booked");
    expect(recorded).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });

  it("refuses a beer that is not a conversion of the batch's own", async () => {
    const { client, recorded } = stub({ ...IN_KEG, sourceRecipeId: "brown-ale" });
    const result = await consumePackagedConversionAdditions(client, {
      sourceBatchId: "src-batch", transferId: "xfer-1",
      packagedRecipeId: "transfusion", volumeBbl: 20,
    });
    expect(result.status).toBe("unlinked");
    expect(recorded).toEqual([]);
  });
});
