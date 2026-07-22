# Variation-aware phantom-export resolve — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a manager resolve a phantom draft-swap alert by picking the correct cold-storage lot (variation + batch) to deduct against, covering both the mislinked-variation and forgotten-stock cases, instead of being locked to the auto-derived variation.

**Execution Budget:** Mode = inline (executing-plans, per CLAUDE.md 4–6 file tier — one locality cluster: the phantom-alert feature). Spawn cap = 2 (no subagent spawns expected). Token target ≈ 120k.

**Architecture:** The alert list already attaches "eligible" cold-storage rows and the UI already has a picker + Dismiss. We (1) broaden eligibility from "batches of the derived variation" to "same-size keg *lots* of the recipe" (`EligibleLot`), (2) make the resolve path take an explicit `variationId` + `batchId`, deplete that lot, and correct the export row's variation label when it differs, guarded by a server-side same-size check so excise/volume never drift, and (3) swap the UI's batch picker for a lot picker.

**Tech Stack:** Next.js 16 App Router route handlers, TypeScript, Supabase (`@supabase/supabase-js`), Vitest, React + @tanstack/react-query, Tailwind v4 token utilities.

## Global Constraints

- Same-size only: a lot may resolve an alert only if its per-keg volume equals the booked volume within `SWAP_VOLUME_TOLERANCE_FL_OZ = 5` fl oz. Excise (`export_transaction_taxes`) and `volume_bbl` are NEVER recomputed. Enforced server-side.
- `is_phantom` is a permanent origin marker — never flipped to false.
- `BBL_TO_FL_OZ = 3968` (from `@/lib/constants/production`).
- Resolve = single lot (one variation + one batch holding the full quantity). Multi-batch/partial is out of scope.
- Role gate on both routes stays `requireRole(["manager"])`.
- No schema/migration changes.
- UI: no raw colors / hand-rolled primitives — reuse `.inp-sm`, `.btn-primary`/`.btn-secondary`, `.btn-xxs`, `<Card>`, `<Modal>` already used in this file.

---

### Task 1: Same-size helpers + `fetchEligibleLots` in `phantomExportAlerts.ts`

**Files:**
- Modify: `lib/production/phantomExportAlerts.ts`
- Test: `lib/production/phantomExportAlerts.test.ts`

**Interfaces:**
- Consumes: `PhantomAlert` (existing, unchanged shape).
- Produces:
  - `export const SWAP_VOLUME_TOLERANCE_FL_OZ = 5`
  - `export function swapPerKegFlOz(volumeBbl: number, quantityKegs: number): number`
  - `export interface EligibleLot { variationId: string; variationName: string; batchId: string; batchCode: string; onHand: number }`
  - `export async function fetchEligibleLots(supabase: SupabaseClient, alert: PhantomAlert): Promise<EligibleLot[]>`
  - REMOVES `EligibleBatch` and `fetchEligibleBatches` (callers updated in Task 3).

- [ ] **Step 1: Update the test file** — replace the `fetchEligibleBatches` import and its `describe` block, add helper coverage.

In `lib/production/phantomExportAlerts.test.ts`, change the import (line 12-18) to:

```ts
import {
  fetchOpenPhantomAlerts,
  fetchUnemailedPhantomAlerts,
  fetchEligibleLots,
  swapPerKegFlOz,
  markPhantomAlertsEmailed,
  type PhantomAlert,
} from "./phantomExportAlerts";
```

Replace the entire `describe("fetchEligibleBatches", ...)` block (lines 128-169) with:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/production/phantomExportAlerts.test.ts`
Expected: FAIL — `swapPerKegFlOz`/`fetchEligibleLots` are not exported.

- [ ] **Step 3: Implement in `lib/production/phantomExportAlerts.ts`**

Add the import at the top (after line 1):

```ts
import { BBL_TO_FL_OZ } from "@/lib/constants/production";
```

Replace the `EligibleBatch` interface (lines 33-37) with:

```ts
export interface EligibleLot {
  variationId: string;
  variationName: string;
  batchId: string;
  batchCode: string;
  onHand: number;
}

/** Max per-keg volume gap (fl oz) for a lot to count as the "same size" as a
 *  booked swap. Keg sizes (661 / 992 / 1984 fl oz) are far enough apart that a
 *  few fl oz of rounding never bleeds across sizes. */
export const SWAP_VOLUME_TOLERANCE_FL_OZ = 5;

/** Per-keg volume (fl oz) a phantom booked: total BBL / keg count × fl oz per BBL. */
export function swapPerKegFlOz(volumeBbl: number, quantityKegs: number): number {
  return quantityKegs > 0 ? (volumeBbl / quantityKegs) * BBL_TO_FL_OZ : 0;
}
```

Replace the `ColdStorageRow` interface (lines 57-61) with:

```ts
interface ColdStorageLotRow {
  batch_id: string;
  variation_id: string;
  quantity_on_hand: number;
  brew_batches: { batch_number: string } | null;
  packaging_variations: {
    name: string;
    total_volume_fl_oz: number | null;
    container: { type: string } | null;
  } | null;
}
```

Replace `fetchEligibleBatches` (lines 153-175) with:

```ts
/**
 * Cold-storage lots (variation + batch) of the alert's recipe that can resolve
 * the swap: a keg container, the SAME per-keg volume the phantom booked (so
 * excise/volume stay valid — never recomputed), and enough on hand for the full
 * swap. Unlike the old batch-only view this offers *every* same-size keg
 * variation the recipe holds, so a mislinked booked variation is still
 * resolvable against the keg physically drained.
 */
export async function fetchEligibleLots(
  supabase: SupabaseClient,
  alert: PhantomAlert,
): Promise<EligibleLot[]> {
  const { data, error } = await supabase
    .from("cold_storage_inventory")
    .select(
      "batch_id, variation_id, quantity_on_hand, brew_batches(batch_number), packaging_variations(name, total_volume_fl_oz, container:packaging_items!packaging_variations_container_id_fkey(type))",
    )
    .eq("recipe_id", alert.recipeId);
  if (error) throw new Error(error.message);
  const perKeg = swapPerKegFlOz(alert.volumeBbl, alert.quantityKegs);
  const rows = (data ?? []) as unknown as ColdStorageLotRow[];
  return rows
    .filter((r) => r.packaging_variations?.container?.type === "keg")
    .filter(
      (r) =>
        r.packaging_variations?.total_volume_fl_oz != null &&
        Math.abs(Number(r.packaging_variations.total_volume_fl_oz) - perKeg) <= SWAP_VOLUME_TOLERANCE_FL_OZ,
    )
    .filter((r) => Number(r.quantity_on_hand) >= alert.quantityKegs)
    .map((r) => ({
      variationId: r.variation_id,
      variationName: r.packaging_variations?.name ?? "",
      batchId: r.batch_id,
      batchCode: r.brew_batches?.batch_number ?? "",
      onHand: Number(r.quantity_on_hand),
    }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/production/phantomExportAlerts.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add lib/production/phantomExportAlerts.ts lib/production/phantomExportAlerts.test.ts
git commit -m "feat(taproom): same-size eligible-lot query for phantom alerts"
```

---

### Task 2: Variation-aware `reconcilePhantomExport`

**Files:**
- Modify: `lib/production/reconcilePhantom.ts`
- Test: `lib/production/reconcilePhantom.test.ts`

**Interfaces:**
- Consumes: `swapPerKegFlOz`, `SWAP_VOLUME_TOLERANCE_FL_OZ` from Task 1; `depleteColdStorageInventory`, `checkAndCompleteBatch` (existing).
- Produces: `reconcilePhantomExport(supabase, { exportTransactionId, variationId, batchId }): Promise<void>` (signature changed — adds `variationId`). `dismissPhantomExport` unchanged. `PhantomReconcileError` unchanged.

- [ ] **Step 1: Update the test file**

In `lib/production/reconcilePhantom.test.ts`, add `volume_bbl` to `openPhantom` (lines 39-47) and replace the `rpvRow` constant + `tables()` helper (lines 48-57) and every `reconcilePhantomExport` call to pass `variationId`. Concretely:

Replace lines 39-57 with:

```ts
const openPhantom = {
  id: "et-1",
  recipe_id: "r1",
  packaging_item_id: "c1",
  packaging_format: "loose",
  quantity: 1,
  volume_bbl: 0.1666, // 1/6 keg → perKeg ≈ 661 fl oz
  is_phantom: true,
  alert_acknowledged_at: null,
};
// Chosen variation whose container matches the booked one (no label correction).
const sameVariation = { id: "pv-1", name: "1/6 Keg", container_id: "c1", format: "loose", total_volume_fl_oz: 661, container: { type: "keg" } };
// Chosen variation on a DIFFERENT container, same size (label correction expected).
const otherVariation = { id: "pv-2", name: "1/6 Keg", container_id: "c2", format: "loose", total_volume_fl_oz: 661, container: { type: "keg" } };

function tables(overrides: Record<string, { rows: unknown[] | null; error?: string | null }> = {}) {
  return {
    export_transactions: { rows: [openPhantom] },
    packaging_variations: { rows: [sameVariation] },
    cold_storage_inventory: { rows: [{ quantity_on_hand: 2 }] },
    ...overrides,
  };
}
```

Replace the existing `reconcilePhantomExport` describe block (lines 64-113) with:

```ts
describe("reconcilePhantomExport", () => {
  it("depletes the chosen lot, backfills batch_id, acknowledges, completes the batch (same variation)", async () => {
    const { client, calls } = makeSupabase(tables());
    await reconcilePhantomExport(client, { exportTransactionId: "et-1", variationId: "pv-1", batchId: "b1" });

    expect(depleteColdStorageInventory).toHaveBeenCalledWith(client, {
      recipeId: "r1",
      variationId: "pv-1",
      quantity: 1,
      batchId: "b1",
    });
    const update = calls.export_transactions.find((c) => c.method === "update");
    expect(update?.args[0]).toMatchObject({ batch_id: "b1", alert_acknowledged_at: expect.any(String) });
    // Same container as booked → no variation-label correction, is_phantom untouched.
    expect(update?.args[0]).not.toHaveProperty("variant_label");
    expect(update?.args[0]).not.toHaveProperty("is_phantom");
    expect(checkAndCompleteBatch).toHaveBeenCalledWith(client, "b1");
  });

  it("corrects the export record's variation when a different same-size keg is chosen", async () => {
    const { client, calls } = makeSupabase(tables({ packaging_variations: { rows: [otherVariation] } }));
    await reconcilePhantomExport(client, { exportTransactionId: "et-1", variationId: "pv-2", batchId: "b1" });
    const update = calls.export_transactions.find((c) => c.method === "update");
    expect(update?.args[0]).toMatchObject({
      batch_id: "b1",
      packaging_item_id: "c2",
      packaging_format: "loose",
      variant_label: "1/6 Keg",
    });
  });

  it("rejects a different-size keg and does not deplete", async () => {
    const bigKeg = { ...sameVariation, total_volume_fl_oz: 1984 };
    const { client } = makeSupabase(tables({ packaging_variations: { rows: [bigKeg] } }));
    await expect(reconcilePhantomExport(client, { exportTransactionId: "et-1", variationId: "pv-1", batchId: "b1" }))
      .rejects.toThrow(/different size/i);
    expect(depleteColdStorageInventory).not.toHaveBeenCalled();
  });

  it("rejects a non-keg variation", async () => {
    const canVar = { ...sameVariation, container: { type: "can" } };
    const { client } = makeSupabase(tables({ packaging_variations: { rows: [canVar] } }));
    await expect(reconcilePhantomExport(client, { exportTransactionId: "et-1", variationId: "pv-1", batchId: "b1" }))
      .rejects.toThrow(/not a keg/i);
  });

  it("rejects when the chosen variation is not found", async () => {
    const { client } = makeSupabase(tables({ packaging_variations: { rows: [] } }));
    await expect(reconcilePhantomExport(client, { exportTransactionId: "et-1", variationId: "pv-x", batchId: "b1" }))
      .rejects.toThrow(/not found/i);
  });

  it("rejects when the export is not found", async () => {
    const { client } = makeSupabase(tables({ export_transactions: { rows: [] } }));
    await expect(reconcilePhantomExport(client, { exportTransactionId: "x", variationId: "pv-1", batchId: "b1" }))
      .rejects.toBeInstanceOf(PhantomReconcileError);
    expect(depleteColdStorageInventory).not.toHaveBeenCalled();
  });

  it("rejects when the export is not a phantom", async () => {
    const { client } = makeSupabase(tables({ export_transactions: { rows: [{ ...openPhantom, is_phantom: false }] } }));
    await expect(reconcilePhantomExport(client, { exportTransactionId: "et-1", variationId: "pv-1", batchId: "b1" }))
      .rejects.toThrow(/not a phantom/i);
  });

  it("rejects when the alert is already resolved", async () => {
    const { client } = makeSupabase(
      tables({ export_transactions: { rows: [{ ...openPhantom, alert_acknowledged_at: "2026-07-18T00:00:00Z" }] } }),
    );
    await expect(reconcilePhantomExport(client, { exportTransactionId: "et-1", variationId: "pv-1", batchId: "b1" }))
      .rejects.toThrow(/already been resolved/i);
  });

  it("rejects and does not deplete when the lot lacks enough on hand", async () => {
    const { client } = makeSupabase(tables({ cold_storage_inventory: { rows: [{ quantity_on_hand: 0.5 }] } }));
    await expect(reconcilePhantomExport(client, { exportTransactionId: "et-1", variationId: "pv-1", batchId: "b1" }))
      .rejects.toThrow(/on hand/i);
    expect(depleteColdStorageInventory).not.toHaveBeenCalled();
  });
});
```

Note: the mock builder in this file already returns `builder` from `.eq()` and resolves via `.then`, so the extra `packaging_variations` query works with a configured table. No mock-helper changes needed.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/production/reconcilePhantom.test.ts`
Expected: FAIL — `reconcilePhantomExport` doesn't accept `variationId` / new behavior missing.

- [ ] **Step 3: Implement in `lib/production/reconcilePhantom.ts`**

Change the import line 4 from:

```ts
import { resolveSwapVariationId } from "./phantomExportAlerts";
```
to:
```ts
import { swapPerKegFlOz, SWAP_VOLUME_TOLERANCE_FL_OZ } from "./phantomExportAlerts";
```

Add `volume_bbl` to the `PhantomRow` interface (lines 28-36) and to the `loadOpenPhantom` select (line 42):

```ts
interface PhantomRow {
  id: string;
  recipe_id: string;
  packaging_item_id: string;
  packaging_format: string | null;
  quantity: number;
  volume_bbl: number;
  is_phantom: boolean;
  alert_acknowledged_at: string | null;
}
```
```ts
    .select("id, recipe_id, packaging_item_id, packaging_format, quantity, volume_bbl, is_phantom, alert_acknowledged_at")
```

Replace the whole body of `reconcilePhantomExport` (lines 52-93) with:

```ts
interface ChosenVariationRow {
  id: string;
  name: string;
  container_id: string;
  format: string | null;
  total_volume_fl_oz: number | null;
  container: { type: string } | null;
}

export async function reconcilePhantomExport(
  supabase: SupabaseClient,
  { exportTransactionId, variationId, batchId }: { exportTransactionId: string; variationId: string; batchId: string },
): Promise<void> {
  const row = await loadOpenPhantom(supabase, exportTransactionId);

  // Load the operator-chosen variation (the keg they actually drained).
  const { data: pvData, error: pvErr } = await supabase
    .from("packaging_variations")
    .select(
      "id, name, container_id, format, total_volume_fl_oz, container:packaging_items!packaging_variations_container_id_fkey(type)",
    )
    .eq("id", variationId);
  if (pvErr) throw new Error(pvErr.message);
  const variation = ((pvData ?? []) as unknown as ChosenVariationRow[])[0];
  if (!variation) throw new PhantomReconcileError("Selected packaging variation not found.");
  if (variation.container?.type !== "keg") throw new PhantomReconcileError("Selected variation is not a keg.");

  // Same-size guard: excise/volume were booked for this keg size and are never
  // recomputed, so only a same-volume keg may resolve the alert.
  const perKeg = swapPerKegFlOz(row.volume_bbl, row.quantity);
  if (
    variation.total_volume_fl_oz == null ||
    Math.abs(Number(variation.total_volume_fl_oz) - perKeg) > SWAP_VOLUME_TOLERANCE_FL_OZ
  ) {
    throw new PhantomReconcileError("Selected keg is a different size than the booked swap.");
  }

  // The chosen lot must hold enough of this recipe/variation/batch to cover the
  // full swap — targeted depletion never takes a batch below zero.
  const { data: lots, error: lotErr } = await supabase
    .from("cold_storage_inventory")
    .select("quantity_on_hand")
    .eq("recipe_id", row.recipe_id)
    .eq("variation_id", variationId)
    .eq("batch_id", batchId);
  if (lotErr) throw new Error(lotErr.message);
  const onHand = ((lots ?? []) as { quantity_on_hand: number }[]).reduce((s, r) => s + Number(r.quantity_on_hand), 0);
  if (onHand < row.quantity) {
    throw new PhantomReconcileError(`Selected batch has ${onHand} on hand but the swap needs ${row.quantity}.`);
  }

  await depleteColdStorageInventory(supabase, {
    recipeId: row.recipe_id,
    variationId,
    quantity: row.quantity,
    batchId,
  });

  // Backfill the batch + acknowledge; correct the record's variation when the
  // chosen keg differs from what was booked (e.g. a mislinked partner variation
  // resolved against the real generic keg). Excise/volume stay as booked.
  const variationChanged =
    variation.container_id !== row.packaging_item_id ||
    (variation.format ?? null) !== (row.packaging_format ?? null);
  const update: Record<string, unknown> = {
    batch_id: batchId,
    alert_acknowledged_at: new Date().toISOString(),
  };
  if (variationChanged) {
    update.packaging_item_id = variation.container_id;
    update.packaging_format = variation.format;
    update.variant_label = variation.name;
  }
  const { error: updErr } = await supabase.from("export_transactions").update(update).eq("id", exportTransactionId);
  if (updErr) throw new Error(updErr.message);

  await checkAndCompleteBatch(supabase, batchId);
}
```

Update the class doc comment (lines 10-14) "Reconcile:" bullet to mention the operator-chosen variation + label correction (one-line edit; keep it accurate).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/production/reconcilePhantom.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add lib/production/reconcilePhantom.ts lib/production/reconcilePhantom.test.ts
git commit -m "feat(taproom): variation-aware phantom resolve with same-size guard"
```

---

### Task 3: Wire the API routes

**Files:**
- Modify: `app/api/production/taproom-consumption/phantom-alerts/route.ts`
- Modify: `app/api/production/taproom-consumption/reconcile-phantom/route.ts`

**Interfaces:**
- Consumes: `fetchEligibleLots` (Task 1), `reconcilePhantomExport({ exportTransactionId, variationId, batchId })` (Task 2).
- Produces: phantom-alerts response `{ alerts: (PhantomAlert & { eligibleLots: EligibleLot[] })[] }`; reconcile-phantom accepts `{ exportTransactionId, variationId, batchId }`.

- [ ] **Step 1: Update `phantom-alerts/route.ts`**

Change the import (line 4):

```ts
import { fetchOpenPhantomAlerts, fetchEligibleLots } from "@/lib/production/phantomExportAlerts";
```

Change the mapping (line 20) and the comment above `GET` ("each with the cold-storage batches" → "lots"):

```ts
    const withLots = await Promise.all(
      alerts.map(async (alert) => ({ ...alert, eligibleLots: await fetchEligibleLots(supabase, alert) })),
    );
    return NextResponse.json({ alerts: withLots });
```

- [ ] **Step 2: Update `reconcile-phantom/route.ts`**

Replace the body-parse + validation + call (lines 16-24) with:

```ts
  let body: { exportTransactionId?: string; variationId?: string; batchId?: string };
  try { body = await req.json(); } catch { return apiError("Invalid JSON body.", 400); }
  const { exportTransactionId, variationId, batchId } = body;
  if (!exportTransactionId || !variationId || !batchId) {
    return apiError("exportTransactionId, variationId and batchId are required.", 400);
  }

  const supabase = await createSupabaseServerClient();
  try {
    await reconcilePhantomExport(supabase, { exportTransactionId, variationId, batchId });
    return NextResponse.json({ ok: true });
```

Update the `// Body:` comment to `{ exportTransactionId, variationId, batchId }`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no references to removed `fetchEligibleBatches`/old signature remain).

- [ ] **Step 4: Commit**

```bash
git add app/api/production/taproom-consumption/phantom-alerts/route.ts app/api/production/taproom-consumption/reconcile-phantom/route.ts
git commit -m "feat(taproom): phantom routes serve eligible lots + accept variationId"
```

---

### Task 4: Lot-picker UI in `ExportBayTab.tsx`

**Files:**
- Modify: `app/production/components/ExportBayTab.tsx`

**Interfaces:**
- Consumes: phantom-alerts response with `eligibleLots`; reconcile mutation now posts `{ exportTransactionId, variationId, batchId }`.
- Produces: no exports (internal component). Lot picker keyed by `` `${variationId}|${batchId}` ``.

- [ ] **Step 1: Update the local types** (lines 91-113)

Replace `PhantomEligibleBatch` and the `eligibleBatches` field:

```ts
/** A cold-storage lot (variation + batch) still eligible to retroactively cover
 *  a phantom export. */
interface PhantomEligibleLot {
  variationId: string;
  variationName: string;
  batchId: string;
  batchCode: string;
  onHand: number;
}
```
In `interface PhantomAlert`, change `eligibleBatches: PhantomEligibleBatch[];` to `eligibleLots: PhantomEligibleLot[];`.

- [ ] **Step 2: Update the reconcile mutation vars** (lines 141-151)

```ts
  const reconcile = useMutation({
    mutationFn: async (vars: { exportTransactionId: string; variationId: string; batchId: string }) => {
      const res = await fetch("/api/production/taproom-consumption/reconcile-phantom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Error");
    },
    onSuccess: invalidate,
  });
```

- [ ] **Step 3: Rewrite `PhantomAlertRow`** (lines 168-231) to a lot picker

```tsx
function PhantomAlertRow({
  alert,
  selectedLotKey,
  onSelectLot,
  onResolve,
  onDismiss,
  resolving,
  dismissing,
}: {
  alert: PhantomAlert;
  selectedLotKey: string;
  onSelectLot: (lotKey: string) => void;
  onResolve: () => void;
  onDismiss: () => void;
  resolving: boolean;
  dismissing: boolean;
}) {
  const hasLots = alert.eligibleLots.length > 0;
  return (
    <Card padding="p-3" className="flex items-center justify-between gap-3">
      <div className="flex flex-col gap-1 min-w-0">
        <span className="text-sm font-medium text-primary">
          {alert.beerName}
          {alert.tapNumber != null && <span className="text-muted font-normal"> · Tap {alert.tapNumber}</span>}
        </span>
        <span className="text-xs text-muted">
          {fmtDate(alert.occurredAt)} · {alert.quantityKegs} keg{alert.quantityKegs !== 1 ? "s" : ""} · {alert.volumeBbl.toFixed(2)} BBL · {alert.variationName}
        </span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {hasLots && (
          <select className="inp-sm" value={selectedLotKey} onChange={(e) => onSelectLot(e.target.value)}>
            <option value="">— pick keg lot —</option>
            {alert.eligibleLots.map((lot) => (
              <option key={`${lot.variationId}|${lot.batchId}`} value={`${lot.variationId}|${lot.batchId}`}>
                {lot.variationName} · {lot.batchCode} ({lot.onHand} on hand)
              </option>
            ))}
          </select>
        )}
        {hasLots && (
          <button type="button" onClick={onResolve} disabled={!selectedLotKey || resolving} className="btn-primary btn-xxs">
            {resolving ? "…" : "Resolve"}
          </button>
        )}
        <button type="button" onClick={onDismiss} disabled={dismissing} className="btn-secondary btn-xxs">
          {dismissing ? "…" : "Dismiss"}
        </button>
      </div>
    </Card>
  );
}
```

- [ ] **Step 4: Rewrite `PhantomAlertsPanel` state + handlers + row props** (lines 233-291)

Replace the state (line 235) and `handleReconcile` (lines 243-252), and the `<PhantomAlertRow .../>` props (lines 273-284):

```tsx
  const [selectedLotByAlert, setSelectedLotByAlert] = useState<Record<string, string>>({});
```
```tsx
  async function handleResolve(alert: PhantomAlert) {
    const lotKey = selectedLotByAlert[alert.exportTransactionId];
    if (!lotKey) return;
    const [variationId, batchId] = lotKey.split("|");
    if (!variationId || !batchId) return;
    setError(null);
    try {
      await reconcile.mutateAsync({ exportTransactionId: alert.exportTransactionId, variationId, batchId });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    }
  }
```
```tsx
              <PhantomAlertRow
                key={alert.exportTransactionId}
                alert={alert}
                selectedLotKey={selectedLotByAlert[alert.exportTransactionId] ?? ""}
                onSelectLot={(lotKey) =>
                  setSelectedLotByAlert((prev) => ({ ...prev, [alert.exportTransactionId]: lotKey }))
                }
                onResolve={() => handleResolve(alert)}
                onDismiss={() => handleDismiss(alert)}
                resolving={reconcile.isPending}
                dismissing={dismiss.isPending}
              />
```

(The empty-state and trigger-button copy at lines 239-241 / 265-267 stay as-is.)

- [ ] **Step 5: Verify build + lint + typecheck**

Run: `npm run verify`
Expected: 0 lint errors, typecheck clean, all tests pass.

- [ ] **Step 6: Browser check (best-effort)**

Start the dev server and open Production → Export Bay. If a manager session is available, open the "⚑ … recorded without cold-storage stock" modal and confirm the lot picker lists same-size keg lots with on-hand and that Resolve is enabled once a lot is chosen. (Editor requires manager auth; if unavailable, note it and rely on `npm run verify`.)

- [ ] **Step 7: Commit**

```bash
git add app/production/components/ExportBayTab.tsx
git commit -m "feat(taproom): Export Bay phantom alert lot picker + Resolve"
```

---

## Task summary

| # | Task | Files | Model |
|---|------|-------|-------|
| 1 | Same-size helpers + `fetchEligibleLots` | `phantomExportAlerts.ts` (+test) | Sonnet |
| 2 | Variation-aware `reconcilePhantomExport` | `reconcilePhantom.ts` (+test) | Sonnet |
| 3 | Wire routes | 2 route handlers | Haiku |
| 4 | Lot-picker UI | `ExportBayTab.tsx` | Sonnet |

All four tasks touch the single phantom-alert locality cluster → execute inline in sequence (executing-plans), no subagent spawns.

## Self-review

- **Spec coverage:** lot picker (Task 4), same-size guard server-side (Tasks 1+2), record correction on variation change (Task 2), offer all same-size keg lots of the recipe incl. generic+partner (Task 1), single-lot v1 (Tasks 1+2), dismiss unchanged (untouched), no migration (confirmed). ✓
- **Placeholder scan:** none — every step has concrete code/commands. ✓
- **Type consistency:** `EligibleLot`/`PhantomEligibleLot` fields (`variationId, variationName, batchId, batchCode, onHand`) match across lib → route → UI; `reconcilePhantomExport({ exportTransactionId, variationId, batchId })` matches route body and mutation vars; lot key `` `${variationId}|${batchId}` `` produced and split consistently. ✓
- **Scope:** single plan, one cluster. ✓
```
