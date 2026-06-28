# Ad-Hoc Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user ship cold-storage inventory to any customer/recipe combination with no existing `batch_allocations` row required, while extracting the regular Ship endpoint's depletion/writing logic into shared `lib/production/` helpers so neither endpoint duplicates it.

**Architecture:** Three new shared lib modules (`exportBayEquipment.ts`, `coldStorageDepletion.ts`, `exportTransactionWriter.ts`) extracted verbatim from `app/api/production/export-bay/ship/route.ts`. The existing Ship route is refactored to call them for its depletion/equipment-lookup/write steps only — its allocation-fetching and crediting logic (Steps 3-4) is untouched. A new `POST /api/production/export-bay/ship-adhoc` route composes the same helpers with `allocationId: null`. A new `GET /api/production/export-bay/active-allocation-check` route is a pure advisory existence check. UI adds an "+ Ad-Hoc Export" button + modal to `ExportBayTab.tsx`.

**Tech Stack:** Next.js 16 App Router route handlers, Supabase JS client, React (client component), TypeScript.

## Global Constraints

- No test runner exists in this repo — verification per task is `npm run lint` and, for the final task, `npm run build`, plus an explicit code-level regression re-trace (no automated test).
- `lib/production/*` helpers must stay free of Next.js coupling — return data/throw nothing special; callers (route handlers) build their own `NextResponse` error responses.
- `cold_storage_inventory` has a unique index on `(batch_id, packaging_item_id, variant_label)` — depletion's per-row FIFO loop never needs to merge rows belonging to the same batch.
- Ad-hoc exports never write to or read `batch_allocations`/`commitments` beyond the advisory existence check.
- Channel literal type already exists: `ExportChannel = "taproom" | "distribution" | "contract_brewing"` (`app/production/types.ts:131`).

---

### Task 1: Extract `getExportBayEquipmentId` helper

**Files:**
- Create: `lib/production/exportBayEquipment.ts`
- Modify: `app/api/production/export-bay/ship/route.ts:146-159` (Step 4b)

**Interfaces:**
- Produces: `getExportBayEquipmentId(supabase: SupabaseClient): Promise<string | null>` — returns the `equipment` row's `id` where `type = 'export_bay'`, or `null` if none exists. Throws only on a genuine Supabase error (propagates the thrown error to the caller — callers don't need to handle a separate error shape since `.maybeSingle()` only errors on transport/SQL failure, not no-row).

- [ ] **Step 1: Write the helper**

```ts
// lib/production/exportBayEquipment.ts
import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Looks up the single `equipment` row of type "export_bay" that all export
 * transfers write to. Returns null (not a thrown error) when none is
 * configured, so callers can fail loudly with their own 500 response —
 * staying consistent with checkAndCompleteBatch/computeExciseTaxBreakdown's
 * existing style of returning plain data, not NextResponse objects.
 */
export async function getExportBayEquipmentId(supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase
    .from("equipment")
    .select("id")
    .eq("type", "export_bay")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.id ?? null;
}
```

- [ ] **Step 2: Refactor the Ship route to call it**

In `app/api/production/export-bay/ship/route.ts`, replace the inline Step 4b block:

```ts
  // ── 4b. Look up the export_bay equipment row (must happen before any write) ─
  const { data: exportBayTank, error: exportBayErr } = await supabase
    .from("equipment")
    .select("id")
    .eq("type", "export_bay")
    .limit(1)
    .maybeSingle();
  if (exportBayErr) return NextResponse.json({ error: exportBayErr.message }, { status: 500 });
  if (!exportBayTank) {
    return NextResponse.json(
      { error: "No 'export_bay' equipment configured — add one in Production → Brewing → Floorplan before shipping." },
      { status: 500 }
    );
  }
  const exportBayId = exportBayTank.id;
```

with:

```ts
  // ── 4b. Look up the export_bay equipment row (must happen before any write) ─
  let exportBayId: string;
  try {
    const id = await getExportBayEquipmentId(supabase);
    if (!id) {
      return NextResponse.json(
        { error: "No 'export_bay' equipment configured — add one in Production → Brewing → Floorplan before shipping." },
        { status: 500 }
      );
    }
    exportBayId = id;
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
```

Add the import at the top of the file:

```ts
import { getExportBayEquipmentId } from "@/lib/production/exportBayEquipment";
```

- [ ] **Step 3: Verify with lint**

Run: `npm run lint`
Expected: no errors in `lib/production/exportBayEquipment.ts` or `app/api/production/export-bay/ship/route.ts`.

- [ ] **Step 4: Commit**

```bash
git add lib/production/exportBayEquipment.ts app/api/production/export-bay/ship/route.ts
git commit -m "refactor: extract getExportBayEquipmentId helper from Ship route"
```

---

### Task 2: Extract cold-storage depletion helpers

**Files:**
- Create: `lib/production/coldStorageDepletion.ts`
- Modify: `app/api/production/export-bay/ship/route.ts` (Step 2 availability sum, Step 5 FIFO depletion loop)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `getAvailableColdStorageQuantity(supabase: SupabaseClient, params: { recipeId: string; packagingItemId: string; variantLabel: string }): Promise<number>`
  - `depleteColdStorageInventory(supabase: SupabaseClient, params: { recipeId: string; packagingItemId: string; variantLabel: string; quantity: number }): Promise<{ batchId: string; depletedQty: number }[]>`

- [ ] **Step 1: Write the helpers**

```ts
// lib/production/coldStorageDepletion.ts
import { SupabaseClient } from "@supabase/supabase-js";

interface ColdStorageKey {
  recipeId: string;
  packagingItemId: string;
  variantLabel: string;
}

/**
 * Sums quantity_on_hand across every cold_storage_inventory row matching
 * the given recipe/packaging/variant — the Export Bay's "how much can I
 * ship" check. Callers reject the request themselves (this returns the
 * raw number, not a NextResponse) so both the regular Ship route and the
 * ad-hoc route can phrase their own "requested X, available Y" message.
 */
export async function getAvailableColdStorageQuantity(
  supabase: SupabaseClient,
  { recipeId, packagingItemId, variantLabel }: ColdStorageKey
): Promise<number> {
  const { data, error } = await supabase
    .from("cold_storage_inventory")
    .select("quantity_on_hand")
    .eq("recipe_id", recipeId)
    .eq("packaging_item_id", packagingItemId)
    .eq("variant_label", variantLabel);
  if (error) throw new Error(error.message);
  return (data ?? []).reduce((s, r) => s + Number(r.quantity_on_hand), 0);
}

/**
 * Depletes cold_storage_inventory oldest-row-first for the given
 * recipe/packaging/variant, up to `quantity` units total. Deletes a row
 * once it hits ~0, otherwise decrements it. Returns one entry per row
 * touched — since (batch_id, packaging_item_id, variant_label) is unique,
 * each entry already belongs to exactly one batch and needs no further
 * aggregation by the caller.
 *
 * Caller must have already verified `quantity` does not exceed the total
 * available (via getAvailableColdStorageQuantity) — this function does not
 * re-check and will simply deplete everything it finds if asked for more.
 */
export async function depleteColdStorageInventory(
  supabase: SupabaseClient,
  { recipeId, packagingItemId, variantLabel, quantity }: ColdStorageKey & { quantity: number }
): Promise<{ batchId: string; depletedQty: number }[]> {
  const { data: rows, error } = await supabase
    .from("cold_storage_inventory")
    .select("id, batch_id, quantity_on_hand, created_at")
    .eq("recipe_id", recipeId)
    .eq("packaging_item_id", packagingItemId)
    .eq("variant_label", variantLabel)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  const depleted: { batchId: string; depletedQty: number }[] = [];
  let qtyLeft = quantity;
  for (const row of rows ?? []) {
    if (qtyLeft <= 0) break;
    const take = Math.min(Number(row.quantity_on_hand), qtyLeft);
    const newQty = Number(row.quantity_on_hand) - take;
    if (newQty <= 0.0001) {
      await supabase.from("cold_storage_inventory").delete().eq("id", row.id);
    } else {
      await supabase.from("cold_storage_inventory").update({ quantity_on_hand: newQty, updated_at: new Date().toISOString() }).eq("id", row.id);
    }
    depleted.push({ batchId: row.batch_id, depletedQty: take });
    qtyLeft -= take;
  }
  return depleted;
}
```

- [ ] **Step 2: Refactor the Ship route's Step 2 (availability check)**

Replace:

```ts
  // ── 2. Validate availability ──────────────────────────────────────────────
  const { data: invRows, error: invErr } = await supabase
    .from("cold_storage_inventory")
    .select("id, batch_id, quantity_on_hand, created_at")
    .eq("recipe_id", recipe_id)
    .eq("packaging_item_id", packaging_item_id)
    .eq("variant_label", variant_label)
    .order("created_at", { ascending: true });
  if (invErr) return NextResponse.json({ error: invErr.message }, { status: 500 });

  const totalAvailable = (invRows ?? []).reduce((s, r) => s + Number(r.quantity_on_hand), 0);
  if (quantity > totalAvailable) {
    return NextResponse.json(
      { error: `Insufficient cold storage inventory for "${variant_label}" — requested ${quantity}, available ${totalAvailable}` },
      { status: 422 }
    );
  }
```

with:

```ts
  // ── 2. Validate availability ──────────────────────────────────────────────
  let totalAvailable: number;
  try {
    totalAvailable = await getAvailableColdStorageQuantity(supabase, {
      recipeId: recipe_id,
      packagingItemId: packaging_item_id,
      variantLabel: variant_label,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
  if (quantity > totalAvailable) {
    return NextResponse.json(
      { error: `Insufficient cold storage inventory for "${variant_label}" — requested ${quantity}, available ${totalAvailable}` },
      { status: 422 }
    );
  }
```

Note: the route no longer has `invRows` in scope for Step 5 — Task 2 Step 3 below replaces that loop entirely with `depleteColdStorageInventory`, so this is safe.

- [ ] **Step 3: Refactor the Ship route's Step 5 (FIFO depletion loop)**

Replace:

```ts
  // ── 5. Deplete cold_storage_inventory, oldest row first ───────────────────
  let qtyLeft = quantity;
  for (const row of invRows ?? []) {
    if (qtyLeft <= 0) break;
    const take = Math.min(Number(row.quantity_on_hand), qtyLeft);
    const newQty = Number(row.quantity_on_hand) - take;
    if (newQty <= 0.0001) {
      await supabase.from("cold_storage_inventory").delete().eq("id", row.id);
    } else {
      await supabase.from("cold_storage_inventory").update({ quantity_on_hand: newQty, updated_at: new Date().toISOString() }).eq("id", row.id);
    }
    qtyLeft -= take;
  }
```

with:

```ts
  // ── 5. Deplete cold_storage_inventory, oldest row first ───────────────────
  try {
    await depleteColdStorageInventory(supabase, {
      recipeId: recipe_id,
      packagingItemId: packaging_item_id,
      variantLabel: variant_label,
      quantity,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
```

(The Ship route doesn't need the per-batch `depletedQty` return value — its crediting math already comes from Steps 3-4's allocation candidates, not from depletion. Only the ad-hoc route, built in Task 5, needs that return value.)

Add the import at the top of the file:

```ts
import { getAvailableColdStorageQuantity, depleteColdStorageInventory } from "@/lib/production/coldStorageDepletion";
```

- [ ] **Step 4: Verify with lint**

Run: `npm run lint`
Expected: no errors. Confirm `invRows` is no longer referenced anywhere in the file (it was only used by the now-removed Step 5 loop and Step 2's removed query) — search the file for `invRows` and ensure zero matches remain.

- [ ] **Step 5: Commit**

```bash
git add lib/production/coldStorageDepletion.ts app/api/production/export-bay/ship/route.ts
git commit -m "refactor: extract cold storage depletion helpers from Ship route"
```

---

### Task 3: Extract export-transaction writer helpers, with regression re-trace

**Files:**
- Create: `lib/production/exportTransactionWriter.ts`
- Modify: `app/api/production/export-bay/ship/route.ts` (Steps 6/7 — `batch_transfers` insert + `export_transactions`/`export_transaction_taxes` insert)

**Interfaces:**
- Consumes: `computeExciseTaxBreakdown(supabase, volumeBbl)` from `lib/production/exciseTax.ts` (existing, unchanged signature).
- Produces:
  - `writeExportTransfer(supabase: SupabaseClient, params: { batchId: string; exportBayId: string; volumeBbl: number; notes?: string | null }): Promise<string>` — returns new `batch_transfers.id`.
  - `writeExportTransaction(supabase: SupabaseClient, params: { shipmentId: string; batchId: string; recipeId: string; packagingItemId: string; variantLabel: string; quantity: number; volumeBbl: number; channel: string; recipientId: string | null; recipientName: string | null; allocationId: string | null; sourceTransferId: string; notes?: string | null }): Promise<string>` — returns new `export_transactions.id`.

- [ ] **Step 1: Write the helpers**

```ts
// lib/production/exportTransactionWriter.ts
import { SupabaseClient } from "@supabase/supabase-js";
import { computeExciseTaxBreakdown } from "@/lib/production/exciseTax";

/**
 * Inserts the batch_transfers row representing one batch's contribution to
 * a shipment (from null — leaving the source tank, since cold storage
 * inventory isn't tank-tracked — to the export_bay equipment row).
 */
export async function writeExportTransfer(
  supabase: SupabaseClient,
  { batchId, exportBayId, volumeBbl, notes }: { batchId: string; exportBayId: string; volumeBbl: number; notes?: string | null }
): Promise<string> {
  const { data, error } = await supabase
    .from("batch_transfers")
    .insert({
      batch_id: batchId,
      from_tank_id: null,
      to_tank_id: exportBayId,
      volume_bbl: Math.round(volumeBbl * 10000) / 10000,
      shrinkage_bbl: 0,
      transfer_type: "export",
      notes: notes ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id;
}

/**
 * Computes the excise tax breakdown for one credited slice and inserts the
 * export_transactions row plus its export_transaction_taxes children.
 * allocationId is an explicit parameter (not inferred) because the regular
 * Ship flow passes the credited allocation's id while ad-hoc exports pass
 * null — there is no allocation to credit.
 */
export async function writeExportTransaction(
  supabase: SupabaseClient,
  params: {
    shipmentId: string;
    batchId: string;
    recipeId: string;
    packagingItemId: string;
    variantLabel: string;
    quantity: number;
    volumeBbl: number;
    channel: string;
    recipientId: string | null;
    recipientName: string | null;
    allocationId: string | null;
    sourceTransferId: string;
    notes?: string | null;
  }
): Promise<string> {
  const taxBreakdown = await computeExciseTaxBreakdown(supabase, params.volumeBbl);
  const totalExciseTaxUsd = Math.round(taxBreakdown.reduce((s, t) => s + t.amountUsd, 0) * 100) / 100;

  const { data: exportTx, error: exTxErr } = await supabase
    .from("export_transactions")
    .insert({
      shipment_id: params.shipmentId,
      batch_id: params.batchId,
      recipe_id: params.recipeId,
      allocation_id: params.allocationId,
      packaging_item_id: params.packagingItemId,
      variant_label: params.variantLabel,
      quantity: params.quantity,
      volume_bbl: Math.round(params.volumeBbl * 10000) / 10000,
      channel: params.channel,
      recipient_id: params.recipientId,
      recipient_name: params.recipientName,
      total_excise_tax_usd: totalExciseTaxUsd,
      source_transfer_id: params.sourceTransferId,
      notes: params.notes ?? null,
    })
    .select("id")
    .single();
  if (exTxErr) throw new Error(exTxErr.message);

  if (taxBreakdown.length > 0) {
    const { error: taxErr } = await supabase.from("export_transaction_taxes").insert(
      taxBreakdown.map((t) => ({
        export_transaction_id: exportTx.id,
        excise_tax_rate_id: t.rateId,
        tax_name: t.name,
        unit: t.unit,
        rate_usd: t.rateUsd,
        amount_usd: t.amountUsd,
      }))
    );
    if (taxErr) throw new Error(taxErr.message);
  }

  return exportTx.id;
}
```

- [ ] **Step 2: Refactor the Ship route's Steps 6/7**

Replace the entire block from `// ── 6/7. Write batch_transfers ...` through the end of the `for (const [batchId, batchCredits] of byBatch)` loop body (everything up to but not including `created.push(...)`) with:

```ts
  // ── 6/7. Write batch_transfers (one per batch) + export_transactions (one per credited allocation) ──
  const shipmentId = crypto.randomUUID();
  const byBatch = new Map<string, Credit[]>();
  for (const c of credits) {
    if (!byBatch.has(c.batchId)) byBatch.set(c.batchId, []);
    byBatch.get(c.batchId)!.push(c);
  }

  const created: { batch_id: string; export_transaction_ids: string[] }[] = [];

  for (const [batchId, batchCredits] of byBatch) {
    const batchTotalBbl = batchCredits.reduce((s, c) => s + c.creditedBbl, 0);

    let transferId: string;
    try {
      transferId = await writeExportTransfer(supabase, { batchId, exportBayId, volumeBbl: batchTotalBbl, notes });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
    }

    const exportTransactionIds: string[] = [];
    for (const c of batchCredits) {
      let exportTxId: string;
      try {
        exportTxId = await writeExportTransaction(supabase, {
          shipmentId,
          batchId,
          recipeId: recipe_id,
          packagingItemId: packaging_item_id,
          variantLabel: variant_label,
          quantity: c.creditedQty,
          volumeBbl: c.creditedBbl,
          channel: c.channel,
          recipientId: partner_id,
          recipientName: null,
          allocationId: c.allocationId,
          sourceTransferId: transferId,
          notes,
        });
      } catch (e) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
      }
      exportTransactionIds.push(exportTxId);
    }

    await checkAndCompleteBatch(supabase, batchId);
    for (const c of batchCredits) {
      await checkAndFulfillCommitment(supabase, c.allocationId);
    }

    created.push({ batch_id: batchId, export_transaction_ids: exportTransactionIds });
  }

  return NextResponse.json({ created }, { status: 201 });
```

Add the import at the top of the file:

```ts
import { writeExportTransfer, writeExportTransaction } from "@/lib/production/exportTransactionWriter";
```

- [ ] **Step 3: Verify with lint**

Run: `npm run lint`
Expected: no errors. Confirm no leftover references to the old inline `computeExciseTaxBreakdown` import usage inside the route file's loop body (the import itself stays in the file only if still used elsewhere in the route — check, and remove the `computeExciseTaxBreakdown` import from `ship/route.ts` if Step 2 above was the only call site).

- [ ] **Step 4: Regression re-trace (required by spec — not optional)**

This refactor touches code that went through 3 review rounds in Spec 2b. Re-run the original hand-traces against the refactored `ship/route.ts` by reading the full file top to bottom and manually tracing this exact scenario:

- A customer has 3 active allocations against 3 different (non-adjacent-in-array) batches for the same recipe, with remaining BBL of 2.0, 1.5, and 3.0 respectively (batches ordered oldest→newest as `[A, B, C]`).
- A ship request comes in for `requestedBbl = 4.0` (computed from `quantity`/`volume_fl_oz` same as before).
- Confirm Step 3-4 (untouched) produces `credits = [{batch: A, creditedBbl: 2.0}, {batch: B, creditedBbl: 1.5}, {batch: C, creditedBbl: 0.5}]` and that the `creditedQty` flat-pass assignment still sums exactly to the original `quantity` (check the comment above that loop — it explicitly calls out why the assignment must NOT depend on `byBatch`'s Map iteration order, and confirm the refactored code still computes `credits[i].creditedQty` before `byBatch` is built, in the same order as before).
- Confirm `byBatch` groups by `batchId` exactly as before (unchanged Map-building code).
- Confirm the refactored loop calls `writeExportTransfer` once per batch with `volumeBbl: batchTotalBbl` (sum of that batch's credits) — matching the original inline `batch_transfers` insert's `volume_bbl: Math.round(batchTotalBbl * 10000) / 10000`. Confirm `writeExportTransfer` internally applies the identical rounding.
- Confirm the refactored loop calls `writeExportTransaction` once per credit with `quantity: c.creditedQty`, `volumeBbl: c.creditedBbl`, `allocationId: c.allocationId` — matching the original inline `export_transactions` insert field-for-field. Confirm `writeExportTransaction` internally applies the identical `Math.round(volumeBbl * 10000) / 10000` and tax-total rounding.
- Confirm `checkAndCompleteBatch` and `checkAndFulfillCommitment` are still called in the same place (after both writes for a batch, inside the `byBatch` loop) and still iterate `batchCredits` for the commitment check — unchanged.
- Write a one-paragraph note in the commit message (Step 5 below) confirming this trace passed, naming the exact scenario traced.

If any divergence is found, fix the refactored code (not the trace) before proceeding — the original behavior is the spec, not the new code.

- [ ] **Step 5: Commit**

```bash
git add lib/production/exportTransactionWriter.ts app/api/production/export-bay/ship/route.ts
git commit -m "$(cat <<'EOF'
refactor: extract export transaction writer helpers from Ship route

Regression re-trace passed: 3 allocations across non-adjacent batches
(2.0/1.5/3.0 BBL remaining) against a 4.0 BBL request reconciles to the
same per-batch transfer volumes and per-credit quantity/volume/allocation
writes as the pre-refactor inline code.
EOF
)"
```

---

### Task 4: `GET /api/production/export-bay/active-allocation-check`

**Files:**
- Create: `app/api/production/export-bay/active-allocation-check/route.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (standalone query).
- Produces: `GET ?partner_id=&recipe_id=` → `{ hasActiveAllocation: boolean }`.

- [ ] **Step 1: Write the route**

```ts
// app/api/production/export-bay/active-allocation-check/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// GET /api/production/export-bay/active-allocation-check?partner_id=&recipe_id=
// Advisory-only existence check used by the Ad-Hoc Export modal to warn
// (non-blocking) when the selected customer already has a real allocation
// for the selected recipe. Mirrors the existence-check shape of the regular
// Ship route's Step 3 query, but skips the production/exported-volume math
// — this only answers "does any allocation exist at all," not "how much
// remains." The ad-hoc endpoint itself never calls or enforces this.
export async function GET(req: NextRequest) {
  const partnerId = req.nextUrl.searchParams.get("partner_id");
  const recipeId = req.nextUrl.searchParams.get("recipe_id");
  if (!partnerId || !recipeId) {
    return NextResponse.json({ error: "partner_id and recipe_id are required" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("batch_allocations")
    .select("id, brew_batches!inner(recipe_id)")
    .eq("partner_id", partnerId)
    .neq("channel", "taproom")
    .eq("brew_batches.recipe_id", recipeId)
    .limit(1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ hasActiveAllocation: (data ?? []).length > 0 });
}
```

- [ ] **Step 2: Verify with lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Manual verification**

Start the dev server (`npm run dev`) and hit the endpoint directly for a partner/recipe pair you know has an allocation and one you know doesn't, e.g.:

```bash
curl "http://localhost:3000/api/production/export-bay/active-allocation-check?partner_id=<known-partner-id>&recipe_id=<known-recipe-id>"
```

Expected: `{"hasActiveAllocation":true}` for a pair with an existing non-taproom allocation, `{"hasActiveAllocation":false}` for a pair with none. (Requires an authenticated session cookie — run this from a logged-in browser tab's dev tools fetch, or skip to UI testing in Task 6 where this gets exercised end-to-end.)

- [ ] **Step 4: Commit**

```bash
git add app/api/production/export-bay/active-allocation-check/route.ts
git commit -m "feat: add active-allocation-check endpoint for Ad-Hoc Export"
```

---

### Task 5: `POST /api/production/export-bay/ship-adhoc`

**Files:**
- Create: `app/api/production/export-bay/ship-adhoc/route.ts`

**Interfaces:**
- Consumes:
  - `getExportBayEquipmentId(supabase)` from Task 1.
  - `getAvailableColdStorageQuantity(supabase, { recipeId, packagingItemId, variantLabel })`, `depleteColdStorageInventory(supabase, { recipeId, packagingItemId, variantLabel, quantity })` from Task 2.
  - `writeExportTransfer(supabase, { batchId, exportBayId, volumeBbl, notes })`, `writeExportTransaction(supabase, { ...allocationId: null... })` from Task 3.
  - `checkAndCompleteBatch(supabase, batchId)` from existing `lib/production/batchCompletion.ts`.
- Produces: `POST` body `{ channel, partner_id?, recipient_name?, recipe_id, packaging_item_id, variant_label, quantity, notes? }` → `201 { created: { batch_id: string; export_transaction_id: string }[] }`.

- [ ] **Step 1: Write the route**

```ts
// app/api/production/export-bay/ship-adhoc/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { checkAndCompleteBatch } from "@/lib/production/batchCompletion";
import { getExportBayEquipmentId } from "@/lib/production/exportBayEquipment";
import { getAvailableColdStorageQuantity, depleteColdStorageInventory } from "@/lib/production/coldStorageDepletion";
import { writeExportTransfer, writeExportTransaction } from "@/lib/production/exportTransactionWriter";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";

export const dynamic = "force-dynamic";

interface AdHocShipRequest {
  channel: "taproom" | "distribution" | "contract_brewing";
  partner_id?: string | null;
  recipient_name?: string | null;
  recipe_id: string;
  packaging_item_id: string;
  variant_label: string;
  quantity: number;
  notes?: string | null;
}

export async function POST(req: NextRequest) {
  try { await requireRole("brewer"); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const body: AdHocShipRequest = await req.json();
  const { channel, partner_id, recipient_name, recipe_id, packaging_item_id, variant_label, quantity, notes } = body;

  if (!channel || !recipe_id || !packaging_item_id || !variant_label || !quantity || quantity <= 0) {
    return NextResponse.json(
      { error: "channel, recipe_id, packaging_item_id, variant_label, and a positive quantity are required" },
      { status: 400 }
    );
  }
  if (channel !== "taproom" && !partner_id) {
    return NextResponse.json({ error: "partner_id is required unless channel is taproom" }, { status: 400 });
  }

  // ── 1. Volume conversion ──────────────────────────────────────────────────
  const { data: pkgItem, error: pkgErr } = await supabase
    .from("packaging_items")
    .select("volume_fl_oz")
    .eq("id", packaging_item_id)
    .single();
  if (pkgErr) return NextResponse.json({ error: pkgErr.message }, { status: 500 });
  const volumeFlOz = pkgItem?.volume_fl_oz ?? null;
  if (volumeFlOz == null) {
    return NextResponse.json({ error: "Selected packaging item has no volume configured — cannot compute BBL." }, { status: 422 });
  }

  // ── 2. Validate availability ──────────────────────────────────────────────
  let totalAvailable: number;
  try {
    totalAvailable = await getAvailableColdStorageQuantity(supabase, {
      recipeId: recipe_id,
      packagingItemId: packaging_item_id,
      variantLabel: variant_label,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
  if (quantity > totalAvailable) {
    return NextResponse.json(
      { error: `Insufficient cold storage inventory for "${variant_label}" — requested ${quantity}, available ${totalAvailable}` },
      { status: 422 }
    );
  }

  // ── 3. Look up the export_bay equipment row (must happen before any write) ─
  let exportBayId: string;
  try {
    const id = await getExportBayEquipmentId(supabase);
    if (!id) {
      return NextResponse.json(
        { error: "No 'export_bay' equipment configured — add one in Production → Brewing → Floorplan before shipping." },
        { status: 500 }
      );
    }
    exportBayId = id;
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }

  // ── 4. Deplete cold_storage_inventory, oldest row first ───────────────────
  let depleted: { batchId: string; depletedQty: number }[];
  try {
    depleted = await depleteColdStorageInventory(supabase, {
      recipeId: recipe_id,
      packagingItemId: packaging_item_id,
      variantLabel: variant_label,
      quantity,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }

  // ── 5. Write one transfer + export transaction per depleted batch row ─────
  const shipmentId = crypto.randomUUID();
  const created: { batch_id: string; export_transaction_id: string }[] = [];

  for (const { batchId, depletedQty } of depleted) {
    const volumeBbl = (depletedQty * volumeFlOz) / BBL_TO_FL_OZ;

    let transferId: string;
    try {
      transferId = await writeExportTransfer(supabase, { batchId, exportBayId, volumeBbl, notes });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
    }

    let exportTxId: string;
    try {
      exportTxId = await writeExportTransaction(supabase, {
        shipmentId,
        batchId,
        recipeId: recipe_id,
        packagingItemId: packaging_item_id,
        variantLabel: variant_label,
        quantity: depletedQty,
        volumeBbl,
        channel,
        recipientId: partner_id ?? null,
        recipientName: recipient_name ?? null,
        allocationId: null,
        sourceTransferId: transferId,
        notes,
      });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
    }

    await checkAndCompleteBatch(supabase, batchId);

    created.push({ batch_id: batchId, export_transaction_id: exportTxId });
  }

  return NextResponse.json({ created }, { status: 201 });
}
```

- [ ] **Step 2: Verify with lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Manual verification against a real recipe/packaging/variant**

With the dev server running and logged in as a brewer+ role, find a recipe/packaging/variant combo with cold storage inventory (check `/api/production/export-bay/inventory`), then:

```bash
curl -X POST http://localhost:3000/api/production/export-bay/ship-adhoc \
  -H "Content-Type: application/json" \
  --cookie "<your session cookie>" \
  -d '{"channel":"taproom","recipe_id":"<id>","packaging_item_id":"<id>","variant_label":"<label>","quantity":1,"notes":"ad-hoc test"}'
```

Expected: `201` with `{"created":[{"batch_id":"...","export_transaction_id":"..."}]}`. Then verify in Supabase (`mcp__supabase__execute_sql` or the dashboard) that: `cold_storage_inventory` quantity dropped by 1, a new `batch_transfers` row exists with `transfer_type = 'export'`, a new `export_transactions` row exists with `allocation_id IS NULL` and `recipient_id IS NULL` (taproom case).

Also verify the 422 path: re-run with `"quantity": 999999` and confirm a 422 with the "Insufficient cold storage inventory" message and no DB writes occurred (re-check inventory unchanged).

- [ ] **Step 4: Commit**

```bash
git add app/api/production/export-bay/ship-adhoc/route.ts
git commit -m "feat: add POST /api/production/export-bay/ship-adhoc endpoint"
```

---

### Task 6: Ad-Hoc Export UI in `ExportBayTab.tsx`

**Files:**
- Modify: `app/production/components/ExportBayTab.tsx`

**Interfaces:**
- Consumes: `useRecipesQuery()`, `useContractPartnersQuery()`, `fetchJson<T>(url)` (all existing, from `../hooks/queries`); `AvailableInventoryLine`, `ExportChannel` types from `../types`; `POST /api/production/export-bay/ship-adhoc` and `GET /api/production/export-bay/active-allocation-check` from Tasks 4-5.
- Produces: no new exports — this is a leaf UI change.

- [ ] **Step 1: Add the "+ Ad-Hoc Export" button and modal state**

In `ExportBayTab.tsx`, add a new import and state alongside `shipGroup`:

```ts
import type { AvailableInventoryLine, BatchAllocation, ExportChannel } from "../types";
```

(extends the existing type import line at the top — add `ExportChannel` to it).

Add new state right after `const [shipGroup, setShipGroup] = useState<CustomerRecipeGroup | null>(null);`:

```ts
  const [showAdHoc, setShowAdHoc] = useState(false);
```

Add the button in the "Available" column header, right after the `<h3>` line:

```tsx
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-zinc-300">Available</h3>
          <button
            onClick={() => setShowAdHoc(true)}
            disabled={inventory.length === 0}
            title={inventory.length === 0 ? "No packaged inventory available" : undefined}
            className="text-xs px-2.5 py-1 border border-amber-700 text-amber-400 hover:bg-amber-900/30 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          >
            + Ad-Hoc Export
          </button>
        </div>
```

Remove the now-duplicated original `<h3 className="text-sm font-medium text-zinc-300 mb-3">Available</h3>` line that this replaces.

Render the modal at the bottom, alongside the existing `{shipGroup && ...}` block:

```tsx
      {showAdHoc && (
        <AdHocExportModal
          inventory={inventory}
          inventoryByRecipe={inventoryByRecipe}
          recipeNameById={recipeNameById}
          onClose={() => setShowAdHoc(false)}
          onDone={() => {
            afterShip();
            setShowAdHoc(false);
          }}
        />
      )}
```

Note `afterShip()` already invalidates both the inventory and allocations queries and resets `shipGroup` — reuse it as-is for the ad-hoc modal too (it doesn't touch `showAdHoc`, so this callback also sets that separately).

- [ ] **Step 2: Write the `AdHocExportModal` component**

Add this new component at the bottom of the file, after the existing `ShipModal`:

```tsx
function AdHocExportModal({ inventory, inventoryByRecipe, recipeNameById, onClose, onDone }: {
  inventory: AvailableInventoryLine[];
  inventoryByRecipe: Map<string, AvailableInventoryLine[]>;
  recipeNameById: Map<string, string>;
  onClose: () => void;
  onDone: () => void;
}) {
  const { data: partners = [] } = useContractPartnersQuery();

  const recipeIds = [...inventoryByRecipe.keys()];
  const [channel, setChannel] = useState<ExportChannel>("taproom");
  const [partnerId, setPartnerId] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [recipeId, setRecipeId] = useState(recipeIds[0] ?? "");
  const linesForRecipe = inventoryByRecipe.get(recipeId) ?? [];
  const [packagingItemId, setPackagingItemId] = useState(linesForRecipe[0]?.packaging_item_id ?? "");
  const [variantLabel, setVariantLabel] = useState(linesForRecipe[0]?.variant_label ?? "");
  const [quantity, setQuantity] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleSelectRecipe(id: string) {
    setRecipeId(id);
    const lines = inventoryByRecipe.get(id) ?? [];
    setPackagingItemId(lines[0]?.packaging_item_id ?? "");
    setVariantLabel(lines[0]?.variant_label ?? "");
  }

  function handleSelectLine(key: string) {
    const line = linesForRecipe.find((l) => `${l.packaging_item_id}|${l.variant_label}` === key);
    if (line) {
      setPackagingItemId(line.packaging_item_id);
      setVariantLabel(line.variant_label);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (channel !== "taproom" && partnerId) {
      try {
        const check = await fetchJson<{ hasActiveAllocation: boolean }>(
          `/api/production/export-bay/active-allocation-check?partner_id=${partnerId}&recipe_id=${recipeId}`
        );
        if (check.hasActiveAllocation) {
          const proceed = window.confirm(
            "This customer already has an active allocation for this recipe — are you sure you want to ship ad-hoc instead of crediting that allocation?"
          );
          if (!proceed) return;
        }
      } catch {
        // Advisory check failing should never block the actual shipment.
      }
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/production/export-bay/ship-adhoc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel,
          partner_id: channel === "taproom" ? null : partnerId,
          recipient_name: channel === "taproom" ? (recipientName || null) : null,
          recipe_id: recipeId,
          packaging_item_id: packagingItemId,
          variant_label: variantLabel,
          quantity: parseFloat(quantity),
          notes: notes || null,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      onDone();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-5 w-full max-w-md space-y-4">
        <h3 className="text-sm font-medium text-zinc-100">Ad-Hoc Export</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs text-zinc-400 block mb-1">Channel</label>
            <select className="inp w-full" value={channel} onChange={(e) => setChannel(e.target.value as ExportChannel)}>
              <option value="taproom">Taproom</option>
              <option value="distribution">Distribution</option>
              <option value="contract_brewing">Contract Brewing</option>
            </select>
          </div>
          {channel !== "taproom" && (
            <div>
              <label className="text-xs text-zinc-400 block mb-1">Partner</label>
              <select className="inp w-full" required value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
                <option value="" disabled>Select a partner…</option>
                {partners.map((p) => (
                  <option key={p.id} value={p.id}>{p.company_name}</option>
                ))}
              </select>
            </div>
          )}
          {channel === "taproom" && (
            <div>
              <label className="text-xs text-zinc-400 block mb-1">Recipient name (optional)</label>
              <input className="inp w-full" value={recipientName} onChange={(e) => setRecipientName(e.target.value)} />
            </div>
          )}
          <div>
            <label className="text-xs text-zinc-400 block mb-1">Recipe</label>
            <select className="inp w-full" value={recipeId} onChange={(e) => handleSelectRecipe(e.target.value)}>
              {recipeIds.map((id) => (
                <option key={id} value={id}>{recipeNameById.get(id) ?? "Unknown recipe"}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-zinc-400 block mb-1">Packaging</label>
            <select
              className="inp w-full"
              value={`${packagingItemId}|${variantLabel}`}
              onChange={(e) => handleSelectLine(e.target.value)}
            >
              {linesForRecipe.map((l) => (
                <option key={`${l.packaging_item_id}|${l.variant_label}`} value={`${l.packaging_item_id}|${l.variant_label}`}>
                  {l.variant_label} ({l.quantity_on_hand} available)
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-zinc-400 block mb-1">Quantity</label>
            <input type="number" min="0" step="1" className="inp w-full" required value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-zinc-400 block mb-1">Notes</label>
            <input className="inp w-full" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="text-xs px-3 py-1.5 text-zinc-400 hover:text-zinc-200">Cancel</button>
            <button type="submit" disabled={submitting || linesForRecipe.length === 0} className="text-xs px-3 py-1.5 bg-amber-700 hover:bg-amber-600 text-zinc-100 rounded disabled:opacity-50">
              {submitting ? "Shipping…" : "Ship"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

Note: `inventory` prop is currently unused inside the component body (only `inventoryByRecipe` is needed) — keep the prop out rather than passing it, to avoid an unused-variable lint warning. Remove `inventory` from both the destructured props and the call site in Step 1.

- [ ] **Step 3: Verify with lint**

Run: `npm run lint`
Expected: no errors, no unused-variable warnings.

- [ ] **Step 4: Verify with build**

Run: `npm run build`
Expected: build succeeds with no type errors.

- [ ] **Step 5: Manual UI verification**

Start the dev server, log in as a brewer+ role, open Production → Export Bay:

- Click "+ Ad-Hoc Export" — confirm the modal opens with Channel defaulted to Taproom, Partner field hidden, Recipe/Packaging populated from current inventory.
- Switch Channel to Distribution — confirm Partner select appears and is required; confirm "Recipient name" field disappears.
- Pick a partner+recipe pair known to have an active allocation, submit — confirm a `window.confirm` dialog appears with the exact warning copy from the spec. Click Cancel — confirm no network request to `ship-adhoc` fires (check Network tab) and the modal stays open.
- Resubmit and accept the confirm — confirm the `ship-adhoc` request fires, returns 201, the modal closes, and the "Available" column's quantity for that variant decreases by the shipped amount.
- Switch back to Taproom, ship without a partner — confirm no `active-allocation-check` request fires (taproom skips it per spec) and the shipment still succeeds.

- [ ] **Step 6: Commit**

```bash
git add app/production/components/ExportBayTab.tsx
git commit -m "feat: add Ad-Hoc Export button and modal to Export Bay"
```

---

### Task 7: Final full-build verification

**Files:** none (verification-only task).

- [ ] **Step 1: Run lint across the whole repo**

Run: `npm run lint`
Expected: zero errors, zero warnings introduced by this feature.

- [ ] **Step 2: Run the production build**

Run: `npm run build`
Expected: build succeeds. This is the closest thing this repo has to an integration test for the three refactored/new route handlers (Next.js type-checks all route handlers and the new lib modules during build).

- [ ] **Step 3: Re-confirm the regular Ship endpoint still works end-to-end**

With the dev server running, exercise the existing Ship flow (Export Bay's "Ship" button against a real allocation) once, exactly as a user would, and confirm: the allocation's "exported/allocated" BBL bar advances correctly, a new `export_transactions` row has `allocation_id` set (non-null, unlike the ad-hoc path), and the batch's `batch_transfers` row looks identical in shape to a pre-refactor shipment (check an older row in the table for comparison if any exist).

- [ ] **Step 4: Commit (if any cleanup was needed)**

Only commit if Steps 1-3 surfaced a fix. If everything passed clean, no commit is needed for this task.
