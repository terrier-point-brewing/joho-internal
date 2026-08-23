import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { calculateShippedIngredientDeposits, shippedDepositDescription } from "./exportIngredientDeposit";

/**
 * Stub of the reads: the selected transactions, the equipment types, the batch,
 * its transfer ledger, and (inside calculateIngredientDeposit) the batch again
 * plus the recipe's ingredient bill.
 *
 * Tank ids are fixed: `tank-1` is the fermenter the batch sits in, `pkg-line`
 * is the canning/kegging station a packaging row delivers into. That split is
 * the whole point — beer in tank-1 is still to be packaged, beer in pkg-line
 * already has been.
 */
function stub(opts: {
  txs: Array<{ batch_id: string | null; volume_bbl: number }>;
  batch: { id: string; beer_name: string; batch_number: string | null; volume_bbl: number; turns: number; recipe_id: string | null } | null;
  /** batch_transfers rows: canning/kegging are packaging, the rest are tank movement. */
  transfers: Array<{ transfer_type: string; volume_bbl: number; from_tank_id?: string | null; to_tank_id?: string | null; shrinkage_bbl?: number }>;
  ingredients: Array<{ quantity_per_turn: number; cost_per_unit_usd: number | null }>;
}): SupabaseClient {
  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {
        select() { return chain; },
        eq(col: string, val: unknown) { filters[col] = val; return chain; },
        in(col: string, val: unknown) { filters[col] = val; return chain; },
        or() { return chain; },
        single() {
          return Promise.resolve(
            opts.batch ? { data: opts.batch, error: null } : { data: null, error: { message: "not found" } },
          );
        },
        then(resolve: (r: { data: unknown[]; error: null }) => void) {
          if (table === "export_transactions") return resolve({ data: opts.txs, error: null });
          if (table === "batch_transfers") {
            return resolve({
              data: opts.transfers.map((t) => ({
                batch_id: "b1",
                from_tank_id: t.from_tank_id ?? "tank-1",
                to_tank_id: t.to_tank_id ?? (t.transfer_type === "canning" || t.transfer_type === "kegging" ? "pkg-line" : null),
                to_batch_id: null,
                volume_bbl: t.volume_bbl,
                shrinkage_bbl: t.shrinkage_bbl ?? 0,
                transferred_at: "2026-07-01T00:00:00Z",
                transfer_type: t.transfer_type,
              })),
              error: null,
            });
          }
          if (table === "equipment") {
            return resolve({
              data: [{ id: "tank-1", type: "fermenter" }, { id: "pkg-line", type: "canning" }],
              error: null,
            });
          }
          if (table === "recipe_ingredients") {
            return resolve({
              data: opts.ingredients.map((ri, i) => ({
                quantity_per_turn: ri.quantity_per_turn,
                ingredients: { id: `ing-${i}`, name: `Ingredient ${i}`, unit: "lb", cost_per_unit_usd: ri.cost_per_unit_usd },
              })),
              error: null,
            });
          }
          return resolve({ data: [], error: null });
        },
      };
      return chain;
    },
  };
  return client as unknown as SupabaseClient;
}

const BATCH = { id: "b1", beer_name: "Pumpkin Ale", batch_number: "B-038", volume_bbl: 20, turns: 1, recipe_id: "r1" };
// A $1,000 bill: the worked example from the shrinkage discussion.
const BILL = [{ quantity_per_turn: 1000, cost_per_unit_usd: 1 }];

describe("calculateShippedIngredientDeposits", () => {
  it("divides by PACKAGED volume, so shrinkage is shared by whoever took beer", async () => {
    // 20 bbl brewed, 18 packaged: the 2 bbl lost still cost money, so a 9 bbl
    // shipment is half the bill ($500), not 9/20ths of it ($450).
    const supabase = stub({
      txs: [{ batch_id: "b1", volume_bbl: 9 }],
      batch: BATCH,
      // 20 bbl seeded into tank-1, 12 + 6 packaged out with 2 bbl of loss: the
      // tank is empty, so the projected yield IS the 18 bbl packaged.
      transfers: [
        { transfer_type: "canning", volume_bbl: 12, shrinkage_bbl: 1 },
        { transfer_type: "kegging", volume_bbl: 6, shrinkage_bbl: 1 },
      ],
      ingredients: BILL,
    });
    const { lines } = await calculateShippedIngredientDeposits(supabase, ["t1"]);
    expect(lines).toHaveLength(1);
    expect(lines[0].packagedBbl).toBe(18);
    expect(lines[0].inTankBbl).toBe(0);
    expect(lines[0].projectedYieldBbl).toBe(18);
    expect(lines[0].percentage).toBeCloseTo(50, 6);
    expect(lines[0].depositCents).toBe(50000);
  });

  it("collapses several shipments off one batch into a single share", async () => {
    // Two transactions, one ingredient bill — charging each separately would
    // bill the same grain twice over.
    const supabase = stub({
      txs: [{ batch_id: "b1", volume_bbl: 6 }, { batch_id: "b1", volume_bbl: 3 }],
      batch: BATCH,
      transfers: [{ transfer_type: "kegging", volume_bbl: 18, shrinkage_bbl: 2 }],
      ingredients: BILL,
    });
    const { lines } = await calculateShippedIngredientDeposits(supabase, ["t1", "t2"]);
    expect(lines).toHaveLength(1);
    expect(lines[0].shippedBbl).toBe(9);
    expect(lines[0].depositCents).toBe(50000);
  });

  it("refuses rather than bill more than the whole bill when shipped exceeds packaged", async () => {
    const supabase = stub({
      txs: [{ batch_id: "b1", volume_bbl: 19 }],
      batch: BATCH,
      transfers: [{ transfer_type: "kegging", volume_bbl: 18, shrinkage_bbl: 2 }],
      ingredients: BILL,
    });
    const { lines, warnings } = await calculateShippedIngredientDeposits(supabase, ["t1"]);
    expect(lines).toEqual([]);
    expect(warnings[0]).toMatch(/only yields 18.00 bbl/);
  });

  it("counts beer still in tank, so shipping mid-packaging can't overcharge", async () => {
    // The guard that matters: 4 bbl packaged of a 20 bbl batch, 16 still in
    // tank. Dividing by packaged-to-date would make a 2 bbl shipment 50% of the
    // batch ($500). Against the projected 20 bbl yield it is 10% ($100).
    const supabase = stub({
      txs: [{ batch_id: "b1", volume_bbl: 2 }],
      batch: BATCH,
      transfers: [{ transfer_type: "canning", volume_bbl: 4 }],
      ingredients: BILL,
    });
    const { lines, warnings } = await calculateShippedIngredientDeposits(supabase, ["t1"]);
    expect(lines[0].packagedBbl).toBe(4);
    expect(lines[0].inTankBbl).toBe(16);
    expect(lines[0].projectedYieldBbl).toBe(20);
    expect(lines[0].percentage).toBeCloseTo(10, 6);
    expect(lines[0].depositCents).toBe(10000);
    expect(lines[0].packagingInProgress).toBe(true);
    expect(warnings.some((w) => /still has 16.00 bbl in tank/.test(w))).toBe(true);
  });

  it("errs low rather than high: the share only rises as the rest is packaged", async () => {
    // Same shipment, same batch, invoiced after packaging finished at 18 bbl.
    // The early figure (10%) is below the final one (11.11%) — never above it.
    const supabase = stub({
      txs: [{ batch_id: "b1", volume_bbl: 2 }],
      batch: BATCH,
      transfers: [{ transfer_type: "canning", volume_bbl: 18, shrinkage_bbl: 2 }],
      ingredients: BILL,
    });
    const { lines } = await calculateShippedIngredientDeposits(supabase, ["t1"]);
    expect(lines[0].percentage).toBeCloseTo(11.1111, 3);
    expect(lines[0].depositCents).toBeGreaterThan(10000);
  });

  it("charges nothing, with a warning, when the batch has no ledger to read a yield from", async () => {
    const supabase = stub({
      txs: [{ batch_id: "b1", volume_bbl: 9 }],
      batch: BATCH,
      transfers: [],
      ingredients: BILL,
    });
    const { lines, warnings } = await calculateShippedIngredientDeposits(supabase, ["t1"]);
    expect(lines).toEqual([]);
    expect(warnings[0]).toMatch(/no transfers recorded/);
  });

  it("does not double-count: a packaging row's destination tank is not 'still to be packaged'", async () => {
    // The prod bug this guards. Canning/kegging deliver into a packaging-station
    // tank, so summing every tank the batch touches counts that beer twice and
    // roughly doubles the denominator. Only fermenter-side volume may count.
    const supabase = stub({
      txs: [{ batch_id: "b1", volume_bbl: 2 }],
      batch: BATCH,
      transfers: [{ transfer_type: "canning", volume_bbl: 8 }],
      ingredients: BILL,
    });
    const { lines } = await calculateShippedIngredientDeposits(supabase, ["t1"]);
    expect(lines[0].packagedBbl).toBe(8);
    expect(lines[0].inTankBbl).toBe(12);       // 20 seeded − 8 drawn, NOT 20
    expect(lines[0].projectedYieldBbl).toBe(20);
  });

  it("puts the derivation in the description, since Square files it as the line note", () => {
    const text = shippedDepositDescription({
      batchId: "b1", batchNumber: "B-038", beerName: "Pumpkin Ale",
      shippedBbl: 3.0968, packagedBbl: 22.9975, inTankBbl: 0, projectedYieldBbl: 22.9975,
      percentage: 13.4659, depositCents: 22917, totalIngredientCostUsd: 1701.79,
      packagingInProgress: false,
    });
    expect(text).toBe("Ingredient Deposit — Pumpkin Ale: 3.10 bbl of the 23.00 bbl packaged (13.47%)");
  });
});
