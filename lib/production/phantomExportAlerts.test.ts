// lib/production/phantomExportAlerts.test.ts
//
// export_transactions does NOT store variation_id (see exportInvoicePreview.ts's
// buildProductLines for the established precedent) — an alert's variationId is
// resolved the same way: recipe_packaging_variations joined to packaging_variations
// on (recipe_id, container_id = packaging_item_id, format = packaging_format).
// tapNumber is resolved via tap_assignments on (recipe_id, swap_variation_id).
// variationName rides directly on export_transactions.variant_label — no extra
// join needed for that field.
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchOpenPhantomAlerts,
  fetchUnemailedPhantomAlerts,
  fetchEligibleLots,
  swapPerKegFlOz,
  markPhantomAlertsEmailed,
  type PhantomAlert,
} from "./phantomExportAlerts";

type Call = { method: string; args: unknown[] };

/** Routes `.from(table)` to fixed per-table data; records every chained call. */
function makeSupabase(tables: Record<string, { rows: unknown[] | null; error?: string | null }>) {
  const calls: Record<string, Call[]> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const from = (table: string): any => {
    const cfg = tables[table] ?? { rows: [] };
    calls[table] = calls[table] ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder: Record<string, any> = {};
    const chain = (method: string) => (...args: unknown[]) => { calls[table].push({ method, args }); return builder; };
    builder.select = chain("select");
    builder.eq = chain("eq");
    builder.is = chain("is");
    builder.in = chain("in");
    builder.order = chain("order");
    builder.update = chain("update");
    builder.then = (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
      Promise.resolve({ data: cfg.rows, error: cfg.error ? { message: cfg.error } : null }).then(resolve);
    return builder;
  };
  return { client: { from } as unknown as SupabaseClient, calls };
}

const phantomTxRow = {
  id: "et-1",
  recipe_id: "r1",
  packaging_item_id: "container-1",
  packaging_format: "loose",
  variant_label: "1/2 Keg",
  quantity: 1,
  volume_bbl: 0.4032,
  total_excise_tax_usd: 2.48,
  created_at: "2026-07-18T20:00:00Z",
  phantom_origin: "draft_swap",
  recipes: { beer_name: "Vienna Lager" },
};

const recipePackagingVariationRow = {
  variation_id: "pv-1",
  packaging_variations: { id: "pv-1", container_id: "container-1", format: "loose" },
};

const tapAssignmentRow = { tap_number: 3 };

function baseTables() {
  return {
    export_transactions: { rows: [phantomTxRow] },
    recipe_packaging_variations: { rows: [recipePackagingVariationRow] },
    tap_assignments: { rows: [tapAssignmentRow] },
  };
}

describe("phantom origin", () => {
  // The bug this guards: recordTaproomConsumption books draft swaps, keg sales
  // and can sales through one path, so every shortfall produced an identical
  // phantom row. Export Bay read them all as draft swaps and resolveTapNumber —
  // which matches on (recipe, swap variation) — handed a keg SALE the tap number
  // of whichever tap happened to be pouring that beer. A wholesale keg sale then
  // read as if a tap had been drained.
  it("does not attach a tap number to a keg sale, even when the beer is on tap", async () => {
    const { client } = makeSupabase({
      ...baseTables(),
      export_transactions: { rows: [{ ...phantomTxRow, phantom_origin: "keg_sale" }] },
    });

    const alerts = await fetchOpenPhantomAlerts(client);

    expect(alerts[0].origin).toBe("keg_sale");
    expect(alerts[0].tapNumber).toBeNull();
  });

  it("does not attach a tap number to a can sale", async () => {
    const { client } = makeSupabase({
      ...baseTables(),
      export_transactions: {
        rows: [{ ...phantomTxRow, phantom_origin: "can_sale", variant_label: "16oz Labeled Can 4-Pack" }],
      },
    });

    const alerts = await fetchOpenPhantomAlerts(client);

    expect(alerts[0].origin).toBe("can_sale");
    expect(alerts[0].tapNumber).toBeNull();
  });

  it("leaves an unclassified legacy row unclassified rather than calling it a swap", async () => {
    const { client } = makeSupabase({
      ...baseTables(),
      export_transactions: { rows: [{ ...phantomTxRow, phantom_origin: null }] },
    });

    const alerts = await fetchOpenPhantomAlerts(client);

    expect(alerts[0].origin).toBeNull();
    expect(alerts[0].tapNumber).toBeNull();
  });

  it("still resolves the tap for a genuine draft swap", async () => {
    const { client } = makeSupabase(baseTables());

    const alerts = await fetchOpenPhantomAlerts(client);

    expect(alerts[0].origin).toBe("draft_swap");
    expect(alerts[0].tapNumber).toBe(3);
  });
});

describe("fetchOpenPhantomAlerts", () => {
  it("returns alerts joined to beer/tap/variation names", async () => {
    const { client, calls } = makeSupabase(baseTables());
    const alerts = await fetchOpenPhantomAlerts(client);
    expect(alerts).toEqual([
      {
        exportTransactionId: "et-1",
        recipeId: "r1",
        beerName: "Vienna Lager",
        origin: "draft_swap",
        tapNumber: 3,
        variationId: "pv-1",
        variationName: "1/2 Keg",
        quantityKegs: 1,
        volumeBbl: 0.4032,
        exciseUsd: 2.48,
        occurredAt: "2026-07-18T20:00:00Z",
      },
    ] satisfies PhantomAlert[]);

    // Filters on is_phantom / alert_acknowledged_at, never alert_emailed_at.
    const etCalls = calls.export_transactions;
    expect(etCalls.some((c) => c.method === "eq" && c.args[0] === "is_phantom" && c.args[1] === true)).toBe(true);
    expect(etCalls.some((c) => c.method === "is" && c.args[0] === "alert_acknowledged_at" && c.args[1] === null)).toBe(true);
    expect(etCalls.some((c) => c.method === "is" && c.args[0] === "alert_emailed_at")).toBe(false);
  });

  it("resolves tapNumber to null when no tap_assignments row matches", async () => {
    const { client } = makeSupabase({ ...baseTables(), tap_assignments: { rows: [] } });
    const alerts = await fetchOpenPhantomAlerts(client);
    expect(alerts[0].tapNumber).toBeNull();
  });

  it("returns an empty list when there are no open phantom rows", async () => {
    const { client } = makeSupabase({ ...baseTables(), export_transactions: { rows: [] } });
    expect(await fetchOpenPhantomAlerts(client)).toEqual([]);
  });

  it("throws when the export_transactions query errors", async () => {
    const { client } = makeSupabase({ ...baseTables(), export_transactions: { rows: null, error: "boom" } });
    await expect(fetchOpenPhantomAlerts(client)).rejects.toThrow("boom");
  });
});

describe("fetchUnemailedPhantomAlerts", () => {
  it("additionally filters on alert_emailed_at IS NULL", async () => {
    const { client, calls } = makeSupabase(baseTables());
    const alerts = await fetchUnemailedPhantomAlerts(client);
    expect(alerts).toHaveLength(1);
    const etCalls = calls.export_transactions;
    expect(etCalls.some((c) => c.method === "eq" && c.args[0] === "is_phantom" && c.args[1] === true)).toBe(true);
    expect(etCalls.some((c) => c.method === "is" && c.args[0] === "alert_acknowledged_at" && c.args[1] === null)).toBe(true);
    expect(etCalls.some((c) => c.method === "is" && c.args[0] === "alert_emailed_at" && c.args[1] === null)).toBe(true);
  });
});

describe("swapPerKegFlOz", () => {
  it("converts total BBL over keg count to per-keg fl oz", () => {
    expect(swapPerKegFlOz(0.1666, 1)).toBeCloseTo(661.1, 0); // 1/6 keg
    expect(swapPerKegFlOz(0.5, 2)).toBeCloseTo(992, 0);       // 1/4 keg each
  });
  it("returns 0 when quantity is 0", () => {
    expect(swapPerKegFlOz(0.5, 0)).toBe(0);
  });
});

describe("fetchEligibleLots", () => {
  // Booked 1/6 keg (perKeg ≈ 661 fl oz).
  const alert: PhantomAlert = {
    exportTransactionId: "et-1",
    recipeId: "r1",
    beerName: "Vienna Lager",
    origin: "draft_swap",
    tapNumber: 3,
    variationId: "pv-1",
    variationName: "Fortnight - 1/6 Keg",
    quantityKegs: 1,
    volumeBbl: 0.1666,
    exciseUsd: 3.77,
    occurredAt: "2026-07-20T20:00:00Z",
  };

  const keg16 = (over: Record<string, unknown>) => ({
    batch_id: "b1",
    variation_id: "pv-generic-16",
    quantity_on_hand: 2,
    brew_batches: { batch_number: "B-050" },
    packaging_variations: { name: "1/6 Keg", total_volume_fl_oz: 661, container: { type: "keg" } },
    ...over,
  });

  it("returns same-size keg lots of the recipe with on-hand >= quantityKegs", async () => {
    const { client, calls } = makeSupabase({
      cold_storage_inventory: {
        rows: [
          keg16({}), // generic 1/6 keg, 2 on hand → eligible even though variation differs from booked
          keg16({ batch_id: "b2", variation_id: "pv-half", quantity_on_hand: 4,
            packaging_variations: { name: "1/2 Keg", total_volume_fl_oz: 1984, container: { type: "keg" } } }), // wrong size
          keg16({ batch_id: "b3", quantity_on_hand: 0.5 }), // right size, too little
          keg16({ batch_id: "b4", variation_id: "pv-can",
            packaging_variations: { name: "16oz Can Case", total_volume_fl_oz: 661, container: { type: "can" } } }), // not a keg
        ],
      },
    });
    const lots = await fetchEligibleLots(client, alert);
    expect(lots).toEqual([
      { variationId: "pv-generic-16", variationName: "1/6 Keg", batchId: "b1", batchCode: "B-050", onHand: 2 },
    ]);
    const csiCalls = calls.cold_storage_inventory;
    expect(csiCalls.some((c) => c.method === "eq" && c.args[0] === "recipe_id" && c.args[1] === "r1")).toBe(true);
  });

  it("returns an empty list when no lot qualifies", async () => {
    const { client } = makeSupabase({
      cold_storage_inventory: { rows: [keg16({ quantity_on_hand: 0.5 })] },
    });
    expect(await fetchEligibleLots(client, alert)).toEqual([]);
  });

  it("throws when the query errors", async () => {
    const { client } = makeSupabase({ cold_storage_inventory: { rows: null, error: "boom" } });
    await expect(fetchEligibleLots(client, alert)).rejects.toThrow("boom");
  });
});

describe("markPhantomAlertsEmailed", () => {
  it("stamps alert_emailed_at on the given export_transactions ids", async () => {
    const { client, calls } = makeSupabase({ export_transactions: { rows: [] } });
    await markPhantomAlertsEmailed(client, ["et-1", "et-2"]);
    const etCalls = calls.export_transactions;
    const update = etCalls.find((c) => c.method === "update");
    expect(update).toBeTruthy();
    expect(update?.args[0]).toMatchObject({ alert_emailed_at: expect.any(String) });
    const inCall = etCalls.find((c) => c.method === "in");
    expect(inCall?.args).toEqual(["id", ["et-1", "et-2"]]);
  });

  it("is a no-op for an empty id list", async () => {
    const { client, calls } = makeSupabase({ export_transactions: { rows: [] } });
    await markPhantomAlertsEmailed(client, []);
    expect(calls.export_transactions ?? []).toEqual([]);
  });
});
