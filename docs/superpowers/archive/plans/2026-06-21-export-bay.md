# Export Bay UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a 2-column Export Bay screen (available cold-storage inventory by recipe+variant next to per-customer allocation fulfillment), replacing the unwired FIFO-over-jsonb export modal/route and the redundant Allocations tab.

**Architecture:** Two new API routes (`GET /api/production/export-bay/inventory`, `POST /api/production/export-bay/ship`) and one new lib helper (`lib/production/commitmentFulfillment.ts`) provide the data and write logic. A new `ExportBayTab.tsx` component renders the 2-column UI and replaces `AllocationsTab` inside the existing `ExportTab.tsx` tab bar. The old `ColdStorageExportModal.tsx` and `cold-storage-export/route.ts` are deleted — confirmed unwired/unused.

**Tech Stack:** Next.js 16 App Router, TypeScript, Tailwind v4, Supabase Postgres, React Query.

## Global Constraints

- No new database tables/migrations — this spec is pure application logic against tables Specs 1/2a already created (`cold_storage_inventory`, `export_transactions`, `export_transaction_taxes`, `batch_allocations`, `commitments`).
- No test runner exists in this repo — verification per task is `npm run lint`, `npm run build`, and (where noted) a manual code-trace or REST-API check. Given there's no staging environment, any live Ship action against real inventory during verification must be explicitly opted into, not assumed.
- `taproom`-channel allocations are excluded from this screen entirely (no `partner_id`, no "Customer" to group by) — filter them out, don't try to display them.
- Inventory depletion (`cold_storage_inventory`, FIFO by `created_at`) and allocation crediting (`batch_allocations`, FIFO by the allocation's batch's `created_at`) are two separate, sequential steps in the Ship endpoint — both oldest-first, but operating on different orderings of different tables. Do not conflate them into one loop.
- The existing `/api/production/allocations` GET's fulfillment computation (`exported_bbl` keyed by `batch_id:channel:partner_id`, summed from `export_transactions`) must stay byte-identical — the Ship endpoint's own internal "remaining allocation" check must use the exact same key/computation so the Allocations display and the Ship validation never disagree.
- A Ship action must reject (422) if the requested quantity exceeds either available inventory OR the customer's total remaining allocation for that recipe — there is no ad-hoc shipping in this spec (Spec 2c relaxes this).
- `batch_transfers` (`transfer_type = 'export'`) rows must still be written by the Ship endpoint, one per distinct batch touched, with `from_tank_id = null` (no tank concept in the new inventory model) and `to_tank_id` = the `export_bay` equipment row — required for `batch_exhaustion`'s `exported_bbl` calculation (filters on destination equipment type) to keep working, which `checkAndCompleteBatch` depends on.

---

### Task 1: Types, query keys, and `recipe_id` on the allocations join

**Files:**
- Modify: `app/production/types.ts` (add `AvailableInventoryLine`, extend `BatchAllocation.brew_batches` with `recipe_id`)
- Modify: `lib/query-keys.ts:15-46` (add `exportBayInventory` key)
- Modify: `app/api/production/allocations/route.ts:14-22` (add `recipe_id` to the `brew_batches` join select)

**Interfaces:**
- Consumes: nothing from other tasks (foundational).
- Produces: `AvailableInventoryLine` interface and `queryKeys.production.exportBayInventory()` consumed by Task 2 (route) and Task 5 (component); `BatchAllocation.brew_batches.recipe_id` consumed by Task 5 for grouping allocations by recipe.

- [ ] **Step 1: Add `AvailableInventoryLine` to `app/production/types.ts`**

Add this near the existing `ColdStorageInventory` interface (added in Spec 1, currently right after `BatchTransfer`):

```ts
/** One row per recipe + packaging variant, summed across every batch — the Export Bay's "Available" column. */
export interface AvailableInventoryLine {
  recipe_id: string;
  packaging_item_id: string;
  variant_label: string;
  quantity_on_hand: number;
}
```

- [ ] **Step 2: Add `recipe_id` to `BatchAllocation.brew_batches`**

In `app/production/types.ts`, find the `BatchAllocation` interface (currently lines 347-377) and change:
```ts
  brew_batches?: { id: string; beer_name: string; batch_number: number; volume_bbl: number } | null;
```
to:
```ts
  brew_batches?: { id: string; beer_name: string; batch_number: number; volume_bbl: number; recipe_id: string | null } | null;
```

- [ ] **Step 3: Add the query key**

In `lib/query-keys.ts`, inside the `production` object (currently lines 15-46), add a new entry right after `allocationsByBatch`:
```ts
    allocationsByBatch:   (batchId: string) => ["production", "allocations", batchId] as const,
    exportBayInventory:   () => ["production", "export-bay-inventory"] as const,
```

- [ ] **Step 4: Add `recipe_id` to the allocations route's join**

In `app/api/production/allocations/route.ts`, find the `GET` handler's select (currently lines 14-22):
```ts
  let query = supabase
    .from("batch_allocations")
    .select(`
      *,
      brew_batches(id, beer_name, batch_number, volume_bbl),
      contract_brewing_partners(id, company_name),
      commitments(id, beer_style, volume_bbl, desired_delivery_date, received_on, created_at, channel),
      conversion_target_recipe:conversion_target_recipe_id(id, beer_name)
    `)
    .order("created_at");
```
Change `brew_batches(id, beer_name, batch_number, volume_bbl)` to `brew_batches(id, beer_name, batch_number, volume_bbl, recipe_id)`.

- [ ] **Step 5: Build and lint**

Run: `npm run lint && npm run build`
Expected: clean — this task only adds fields, doesn't remove anything existing code depends on.

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # confirm NOT main before committing
git add app/production/types.ts lib/query-keys.ts app/api/production/allocations/route.ts
git commit -m "Add AvailableInventoryLine type, export-bay-inventory query key, recipe_id on allocations join"
```

---

### Task 2: `GET /api/production/export-bay/inventory`

**Files:**
- Create: `app/api/production/export-bay/inventory/route.ts`

**Interfaces:**
- Consumes: `cold_storage_inventory` table (Spec 1).
- Produces: `GET /api/production/export-bay/inventory` returning `AvailableInventoryLine[]` (defined in Task 1), consumed by Task 5.

- [ ] **Step 1: Write the route**

```ts
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// GET /api/production/export-bay/inventory
// Returns available cold-storage inventory grouped by recipe + packaging
// variant, summed across every batch — the Export Bay's "Available" column.
// No batch breakdown is exposed; from a shipping standpoint the user only
// cares about total units on hand per recipe+variant.
export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("cold_storage_inventory")
    .select("recipe_id, packaging_item_id, variant_label, quantity_on_hand")
    .not("recipe_id", "is", null);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const grouped = new Map<string, { recipe_id: string; packaging_item_id: string; variant_label: string; quantity_on_hand: number }>();
  for (const row of data ?? []) {
    const key = `${row.recipe_id}|${row.packaging_item_id}|${row.variant_label}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.quantity_on_hand += Number(row.quantity_on_hand);
    } else {
      grouped.set(key, {
        recipe_id: row.recipe_id as string,
        packaging_item_id: row.packaging_item_id,
        variant_label: row.variant_label,
        quantity_on_hand: Number(row.quantity_on_hand),
      });
    }
  }

  const lines = [...grouped.values()].filter((l) => l.quantity_on_hand > 0.001);
  return NextResponse.json(lines);
}
```

- [ ] **Step 2: Build and lint**

Run: `npm run lint && npm run build`
Expected: clean.

- [ ] **Step 3: Verify against the live database**

Run (no live writes, just a read):
```bash
source .env.local
curl -s "$SUPABASE_URL/rest/v1/cold_storage_inventory?select=recipe_id,packaging_item_id,variant_label,quantity_on_hand" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```
Expected: confirms what rows exist today; cross-check that the route's grouping logic would correctly sum any rows sharing the same `(recipe_id, packaging_item_id, variant_label)`. If the table is currently empty, that's fine — the route should return `[]`, not error.

- [ ] **Step 4: Commit**

```bash
git branch --show-current   # confirm NOT main before committing
git add app/api/production/export-bay/inventory/route.ts
git commit -m "Add GET /api/production/export-bay/inventory"
```

---

### Task 3: Commitment fulfillment helper

**Files:**
- Create: `lib/production/commitmentFulfillment.ts`

**Interfaces:**
- Consumes: `SupabaseClient`, `batch_allocations`/`commitments`/`brew_batches`/`export_transactions` tables.
- Produces: `checkAndFulfillCommitment(supabase: SupabaseClient, allocationId: string): Promise<void>`, consumed by Task 4.

- [ ] **Step 1: Write the helper**

```ts
import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Checks whether the commitment backing a given allocation has been fully
 * met and, if so, marks it "fulfilled". A commitment can only be fulfilled
 * once its batch reaches "complete" — until then, allocated_bbl is a moving
 * target (it's a percentage of produced_bbl, which isn't final until the
 * batch stops accepting more kegging/canning) — so checking exported_bbl
 * against an intermediate allocated_bbl would be meaningless.
 */
export async function checkAndFulfillCommitment(supabase: SupabaseClient, allocationId: string): Promise<void> {
  const { data: allocation } = await supabase
    .from("batch_allocations")
    .select("id, batch_id, channel, partner_id, percentage, contract_request_id")
    .eq("id", allocationId)
    .single();
  if (!allocation?.contract_request_id) return;

  const { data: batch } = await supabase
    .from("brew_batches")
    .select("status")
    .eq("id", allocation.batch_id)
    .single();
  if (batch?.status !== "complete") return;

  const { data: transfers } = await supabase
    .from("batch_transfers")
    .select("volume_bbl, shrinkage_bbl, transfer_type")
    .eq("batch_id", allocation.batch_id)
    .in("transfer_type", ["kegging", "canning"]);
  const producedBbl = (transfers ?? []).reduce(
    (s, t) => s + (Number(t.volume_bbl) - Number(t.shrinkage_bbl ?? 0)),
    0
  );
  if (producedBbl <= 0) return;
  const allocatedBbl = (Number(allocation.percentage) / 100) * producedBbl;

  const { data: exports_ } = await supabase
    .from("export_transactions")
    .select("volume_bbl")
    .eq("batch_id", allocation.batch_id)
    .eq("channel", allocation.channel)
    .eq("recipient_id", allocation.partner_id);
  const exportedBbl = (exports_ ?? []).reduce((s, e) => s + Number(e.volume_bbl), 0);

  if (exportedBbl < allocatedBbl) return;

  const { data: commitment } = await supabase
    .from("commitments")
    .select("status")
    .eq("id", allocation.contract_request_id)
    .single();
  if (commitment?.status === "fulfilled") return;

  await supabase.from("commitments").update({ status: "fulfilled" }).eq("id", allocation.contract_request_id);
}
```

This computation deliberately mirrors `/api/production/allocations`'s `produced_bbl`/`allocated_bbl`/`exported_bbl` logic exactly (same `batch_id:channel:partner_id`-equivalent key, same percentage math) so the two never disagree about whether an allocation is fulfilled.

- [ ] **Step 2: Build and lint**

Run: `npm run lint && npm run build`
Expected: clean (new, unimported file — can't introduce new errors yet).

- [ ] **Step 3: Commit**

```bash
git branch --show-current   # confirm NOT main before committing
git add lib/production/commitmentFulfillment.ts
git commit -m "Add checkAndFulfillCommitment helper"
```

---

### Task 4: `POST /api/production/export-bay/ship`

**Files:**
- Create: `app/api/production/export-bay/ship/route.ts`
- Delete: `app/api/production/cold-storage-export/route.ts`

**Interfaces:**
- Consumes: `checkAndCompleteBatch` (`lib/production/batchCompletion.ts`, Spec 2a), `computeExciseTaxBreakdown` (`lib/production/exciseTax.ts`, Spec 2a), `checkAndFulfillCommitment` (Task 3), `BBL_TO_FL_OZ`/`GALLONS_PER_BBL` (`lib/constants/production.ts`).
- Produces: `POST /api/production/export-bay/ship` accepting `{ partner_id, recipe_id, packaging_item_id, variant_label, quantity, notes? }`, returning `{ created: { batch_id: string; export_transaction_ids: string[] }[] }`. No other task consumes this route directly — Task 5's UI calls it via `fetch`.

- [ ] **Step 1: Delete the old route**

```bash
git rm app/api/production/cold-storage-export/route.ts
```
(Confirmed unwired/unused — `ColdStorageExportModal.tsx`, its only caller, is deleted in Task 6.)

- [ ] **Step 2: Write the new route**

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { checkAndCompleteBatch } from "@/lib/production/batchCompletion";
import { checkAndFulfillCommitment } from "@/lib/production/commitmentFulfillment";
import { computeExciseTaxBreakdown } from "@/lib/production/exciseTax";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";

export const dynamic = "force-dynamic";

interface ShipRequest {
  partner_id: string;
  recipe_id: string;
  packaging_item_id: string;
  variant_label: string;
  quantity: number;
  notes?: string | null;
}

export async function POST(req: NextRequest) {
  try { await requireRole("brewer"); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const body: ShipRequest = await req.json();
  const { partner_id, recipe_id, packaging_item_id, variant_label, quantity, notes } = body;

  if (!partner_id || !recipe_id || !packaging_item_id || !variant_label || !quantity || quantity <= 0) {
    return NextResponse.json({ error: "partner_id, recipe_id, packaging_item_id, variant_label, and a positive quantity are required" }, { status: 400 });
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
  const requestedBbl = (quantity * volumeFlOz) / BBL_TO_FL_OZ;

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

  // ── 3. Fetch this customer's eligible allocations for this recipe ────────
  const { data: allocRows, error: allocErr } = await supabase
    .from("batch_allocations")
    .select(`
      id, batch_id, channel, partner_id, percentage, contract_request_id,
      brew_batches!inner(id, recipe_id, created_at)
    `)
    .eq("partner_id", partner_id)
    .neq("channel", "taproom")
    .eq("brew_batches.recipe_id", recipe_id);
  if (allocErr) return NextResponse.json({ error: allocErr.message }, { status: 500 });

  const batchIds = [...new Set((allocRows ?? []).map((a) => a.batch_id))];
  const { data: prodTransfers } = await supabase
    .from("batch_transfers")
    .select("batch_id, volume_bbl, shrinkage_bbl")
    .in("batch_id", batchIds.length > 0 ? batchIds : ["00000000-0000-0000-0000-000000000000"])
    .in("transfer_type", ["kegging", "canning"]);
  const producedByBatch: Record<string, number> = {};
  for (const t of prodTransfers ?? []) {
    producedByBatch[t.batch_id] = (producedByBatch[t.batch_id] ?? 0) + (Number(t.volume_bbl) - Number(t.shrinkage_bbl ?? 0));
  }

  const { data: priorExports } = await supabase
    .from("export_transactions")
    .select("batch_id, channel, recipient_id, volume_bbl")
    .in("batch_id", batchIds.length > 0 ? batchIds : ["00000000-0000-0000-0000-000000000000"]);
  const exportedByKey: Record<string, number> = {};
  for (const e of priorExports ?? []) {
    const key = `${e.batch_id}:${e.channel}:${e.recipient_id ?? ""}`;
    exportedByKey[key] = (exportedByKey[key] ?? 0) + Number(e.volume_bbl);
  }

  type Candidate = { allocationId: string; batchId: string; channel: string; remainingBbl: number; batchCreatedAt: string };
  const candidates: Candidate[] = [];
  for (const a of allocRows ?? []) {
    const produced = producedByBatch[a.batch_id] ?? 0;
    if (produced <= 0) continue; // pending production — not a crediting candidate
    const allocatedBbl = (Number(a.percentage) / 100) * produced;
    const key = `${a.batch_id}:${a.channel}:${a.partner_id ?? ""}`;
    const exportedBbl = exportedByKey[key] ?? 0;
    const remaining = allocatedBbl - exportedBbl;
    if (remaining <= 0.0001) continue;
    const batchRow = a.brew_batches as unknown as { created_at: string };
    candidates.push({ allocationId: a.id, batchId: a.batch_id, channel: a.channel, remainingBbl: remaining, batchCreatedAt: batchRow.created_at });
  }
  candidates.sort((x, y) => new Date(x.batchCreatedAt).getTime() - new Date(y.batchCreatedAt).getTime());

  const totalRemaining = candidates.reduce((s, c) => s + c.remainingBbl, 0);
  if (requestedBbl > totalRemaining + 0.0001) {
    return NextResponse.json(
      { error: `Requested ${requestedBbl.toFixed(4)} BBL exceeds this customer's remaining allocation for this recipe (${totalRemaining.toFixed(4)} BBL).` },
      { status: 422 }
    );
  }

  // ── 4. Credit allocations sequentially, oldest batch first ───────────────
  type Credit = { allocationId: string; batchId: string; channel: string; creditedBbl: number };
  const credits: Credit[] = [];
  let bblLeft = requestedBbl;
  for (let i = 0; i < candidates.length && bblLeft > 0.0001; i++) {
    const c = candidates[i];
    const isLast = i === candidates.length - 1 || bblLeft <= c.remainingBbl;
    const creditedBbl = isLast ? bblLeft : Math.min(c.remainingBbl, bblLeft);
    credits.push({ allocationId: c.allocationId, batchId: c.batchId, channel: c.channel, creditedBbl });
    bblLeft -= creditedBbl;
  }

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

  // ── 6. Look up the export_bay equipment row ───────────────────────────────
  const { data: exportBayTank } = await supabase.from("equipment").select("id").eq("type", "export_bay").limit(1).single();
  const exportBayId = exportBayTank?.id ?? null;

  // ── 7. Write batch_transfers (one per batch) + export_transactions (one per credited allocation) ──
  const shipmentId = crypto.randomUUID();
  const byBatch = new Map<string, Credit[]>();
  for (const c of credits) {
    if (!byBatch.has(c.batchId)) byBatch.set(c.batchId, []);
    byBatch.get(c.batchId)!.push(c);
  }

  const created: { batch_id: string; export_transaction_ids: string[] }[] = [];

  for (const [batchId, batchCredits] of byBatch) {
    const batchTotalBbl = batchCredits.reduce((s, c) => s + c.creditedBbl, 0);

    const { data: transfer, error: trErr } = await supabase
      .from("batch_transfers")
      .insert({
        batch_id: batchId,
        from_tank_id: null,
        to_tank_id: exportBayId,
        volume_bbl: Math.round(batchTotalBbl * 10000) / 10000,
        shrinkage_bbl: 0,
        transfer_type: "export",
        notes: notes ?? null,
      })
      .select("id")
      .single();
    if (trErr) return NextResponse.json({ error: trErr.message }, { status: 500 });

    const exportTransactionIds: string[] = [];
    for (const c of batchCredits) {
      const creditedQty = Math.round((c.creditedBbl / requestedBbl) * quantity * 10000) / 10000;
      const taxBreakdown = await computeExciseTaxBreakdown(supabase, c.creditedBbl);
      const totalExciseTaxUsd = Math.round(taxBreakdown.reduce((s, t) => s + t.amountUsd, 0) * 100) / 100;

      const { data: exportTx, error: exTxErr } = await supabase
        .from("export_transactions")
        .insert({
          shipment_id: shipmentId,
          batch_id: batchId,
          recipe_id,
          allocation_id: c.allocationId,
          packaging_item_id,
          variant_label,
          quantity: creditedQty,
          volume_bbl: Math.round(c.creditedBbl * 10000) / 10000,
          channel: c.channel,
          recipient_id: partner_id,
          recipient_name: null,
          total_excise_tax_usd: totalExciseTaxUsd,
          source_transfer_id: transfer.id,
          notes: notes ?? null,
        })
        .select("id")
        .single();
      if (exTxErr) return NextResponse.json({ error: exTxErr.message }, { status: 500 });

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
        if (taxErr) return NextResponse.json({ error: taxErr.message }, { status: 500 });
      }

      exportTransactionIds.push(exportTx.id);
    }

    await checkAndCompleteBatch(supabase, batchId);
    for (const c of batchCredits) {
      await checkAndFulfillCommitment(supabase, c.allocationId);
    }

    created.push({ batch_id: batchId, export_transaction_ids: exportTransactionIds });
  }

  return NextResponse.json({ created }, { status: 201 });
}
```

Note on `creditedQty` (Step 7): since one `quantity` (in units) maps to one `requestedBbl`, and credits are computed in BBL, each credit's unit quantity is derived proportionally (`creditedBbl / requestedBbl * quantity`) rather than re-deriving from `volumeFlOz` independently — this guarantees the credited quantities sum to exactly the requested `quantity` (modulo the rounding already applied), consistent with the "last entry absorbs remainder" convention used elsewhere, since `bblLeft`'s exact-zero-out in Step 4 already guarantees the BBL amounts sum exactly.

- [ ] **Step 3: Build and lint**

Run: `npm run lint && npm run build`
Expected: clean except `app/production/components/ColdStorageExportModal.tsx` (still imports the now-deleted route's exported types `ExportLineItem`/`ColdStorageExportRequest` — Task 6 deletes this file) and `ExportTab.tsx`'s `AllocationsTab` (unaffected by this task, still fine) — any other error is a real problem to fix in this task.

- [ ] **Step 4: Commit**

```bash
git branch --show-current   # confirm NOT main before committing
git add app/api/production/export-bay/ship/route.ts
git rm app/api/production/cold-storage-export/route.ts
git commit -m "Add POST /api/production/export-bay/ship, remove old cold-storage-export route"
```

---

### Task 5: `ExportBayTab.tsx`

**Files:**
- Create: `app/production/components/ExportBayTab.tsx`

**Interfaces:**
- Consumes: `GET /api/production/export-bay/inventory` (Task 2), `POST /api/production/export-bay/ship` (Task 4), `GET /api/production/allocations` (existing, extended in Task 1), `AvailableInventoryLine`/`BatchAllocation` types (Task 1), `useRecipesQuery`/`fetchJson` (`../hooks/queries`), `useContractPartnersQuery` (`../hooks/queries`, used by the old modal — confirm it still exists), `queryKeys` (`@/lib/query-keys`).
- Produces: default-exported `ExportBayTab` component, consumed by Task 6.

- [ ] **Step 1: Confirm `useContractPartnersQuery` exists and its return shape**

Run: `grep -n "useContractPartnersQuery" app/production/hooks/queries.ts`
Expected: a hook returning partner rows shaped `{ id: string; company_name: string }[]` (same one `ColdStorageExportModal.tsx` already uses) — use this exact hook, don't write a new query for partners.

- [ ] **Step 2: Write the component**

```tsx
"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRecipesQuery, useContractPartnersQuery, fetchJson } from "../hooks/queries";
import type { AvailableInventoryLine, BatchAllocation } from "../types";
import { queryKeys } from "@/lib/query-keys";

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

interface CustomerRecipeGroup {
  partnerId: string;
  partnerName: string;
  recipeId: string;
  recipeName: string;
  allocations: BatchAllocation[];
}

export default function ExportBayTab() {
  const qc = useQueryClient();
  const { data: inventory = [], isLoading: inventoryLoading } = useQuery({
    queryKey: queryKeys.production.exportBayInventory(),
    queryFn: () => fetchJson<AvailableInventoryLine[]>("/api/production/export-bay/inventory"),
  });
  const { data: allocations = [], isLoading: allocationsLoading } = useQuery({
    queryKey: queryKeys.production.allocations(),
    queryFn: () => fetchJson<BatchAllocation[]>("/api/production/allocations"),
  });
  const { data: recipes = [] } = useRecipesQuery();
  const { data: partners = [] } = useContractPartnersQuery();

  const recipeNameById = new Map(recipes.map((r) => [r.id, r.beer_name]));
  const partnerNameById = new Map(partners.map((p) => [p.id, p.company_name]));

  const [shipGroup, setShipGroup] = useState<CustomerRecipeGroup | null>(null);

  if (inventoryLoading || allocationsLoading) {
    return <p className="text-sm text-zinc-600 py-8 text-center">Loading…</p>;
  }

  // Group allocations by partner + recipe, excluding taproom (no customer to group by).
  const groups = new Map<string, CustomerRecipeGroup>();
  for (const a of allocations) {
    if (a.channel === "taproom") continue;
    const partnerId = a.partner_id;
    const recipeId = a.brew_batches?.recipe_id;
    if (!partnerId || !recipeId) continue;
    const key = `${partnerId}|${recipeId}`;
    const existing = groups.get(key);
    if (existing) {
      existing.allocations.push(a);
    } else {
      groups.set(key, {
        partnerId,
        partnerName: partnerNameById.get(partnerId) ?? "Unknown",
        recipeId,
        recipeName: recipeNameById.get(recipeId) ?? "Unknown recipe",
        allocations: [a],
      });
    }
  }

  // Group inventory by recipe.
  const inventoryByRecipe = new Map<string, AvailableInventoryLine[]>();
  for (const line of inventory) {
    const list = inventoryByRecipe.get(line.recipe_id) ?? [];
    list.push(line);
    inventoryByRecipe.set(line.recipe_id, list);
  }

  function afterShip() {
    qc.invalidateQueries({ queryKey: queryKeys.production.exportBayInventory() });
    qc.invalidateQueries({ queryKey: queryKeys.production.allocations() });
    setShipGroup(null);
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {/* ── Left column: Available ── */}
      <div>
        <h3 className="text-sm font-medium text-zinc-300 mb-3">Available</h3>
        {inventory.length === 0 ? (
          <p className="text-sm text-zinc-600">Nothing in cold storage right now.</p>
        ) : (
          <div className="space-y-4">
            {[...inventoryByRecipe.entries()].map(([recipeId, lines]) => (
              <div key={recipeId} className="rounded-lg border border-zinc-800 overflow-hidden">
                <div className="px-3 py-2 bg-zinc-900/60 border-b border-zinc-800 text-sm font-medium text-zinc-100">
                  {recipeNameById.get(recipeId) ?? "Unknown recipe"}
                </div>
                <div className="divide-y divide-zinc-800">
                  {lines.map((l) => (
                    <div key={`${l.packaging_item_id}|${l.variant_label}`} className="flex items-center justify-between px-3 py-2 text-sm">
                      <span className="text-zinc-300">{l.variant_label}</span>
                      <span className="text-zinc-400 tabular-nums">{l.quantity_on_hand}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Right column: Allocations ── */}
      <div>
        <h3 className="text-sm font-medium text-zinc-300 mb-3">Allocations</h3>
        {groups.size === 0 ? (
          <p className="text-sm text-zinc-600">No active allocations.</p>
        ) : (
          <div className="space-y-4">
            {[...groups.values()].map((g) => (
              <div key={`${g.partnerId}|${g.recipeId}`} className="rounded-lg border border-zinc-800 overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 bg-zinc-900/60 border-b border-zinc-800">
                  <span className="text-sm font-medium text-zinc-100">{g.partnerName} — {g.recipeName}</span>
                  <button
                    onClick={() => setShipGroup(g)}
                    className="text-xs px-2.5 py-1 border border-amber-700 text-amber-400 hover:bg-amber-900/30 rounded transition-colors"
                  >
                    Ship
                  </button>
                </div>
                <div className="divide-y divide-zinc-800">
                  {g.allocations.map((a) => (
                    <div key={a.id} className="flex items-center justify-between px-3 py-2 text-sm">
                      <div className="flex items-center gap-2">
                        <span className="text-zinc-400 font-mono text-xs">
                          {a.brew_batches ? `#${a.brew_batches.batch_number}` : "—"}
                        </span>
                        <span className="text-zinc-500 text-xs">Due {fmtDate(a.commitments?.desired_delivery_date ?? null)}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-zinc-400 tabular-nums text-xs">
                          {a.exported_bbl.toFixed(2)} / {a.allocated_bbl != null ? a.allocated_bbl.toFixed(2) : "—"} BBL
                        </span>
                        {a.allocated_bbl == null ? (
                          <span className="text-xs text-zinc-600">Pending production</span>
                        ) : a.fulfilled ? (
                          <span className="text-xs text-emerald-400">Fulfilled</span>
                        ) : (
                          <span className="text-xs text-amber-400">
                            {a.allocated_bbl > 0 ? `${((a.exported_bbl / a.allocated_bbl) * 100).toFixed(0)}%` : "Unfulfilled"}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {shipGroup && (
        <ShipModal
          group={shipGroup}
          inventoryLines={inventoryByRecipe.get(shipGroup.recipeId) ?? []}
          onClose={() => setShipGroup(null)}
          onDone={afterShip}
        />
      )}
    </div>
  );
}

function ShipModal({ group, inventoryLines, onClose, onDone }: {
  group: CustomerRecipeGroup;
  inventoryLines: AvailableInventoryLine[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [packagingItemId, setPackagingItemId] = useState(inventoryLines[0]?.packaging_item_id ?? "");
  const [variantLabel, setVariantLabel] = useState(inventoryLines[0]?.variant_label ?? "");
  const [quantity, setQuantity] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleSelectLine(key: string) {
    const line = inventoryLines.find((l) => `${l.packaging_item_id}|${l.variant_label}` === key);
    if (line) {
      setPackagingItemId(line.packaging_item_id);
      setVariantLabel(line.variant_label);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/production/export-bay/ship", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partner_id: group.partnerId,
          recipe_id: group.recipeId,
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
        <h3 className="text-sm font-medium text-zinc-100">Ship to {group.partnerName} — {group.recipeName}</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs text-zinc-400 block mb-1">Packaging</label>
            <select
              className="inp w-full"
              value={`${packagingItemId}|${variantLabel}`}
              onChange={(e) => handleSelectLine(e.target.value)}
            >
              {inventoryLines.map((l) => (
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
            <button type="submit" disabled={submitting} className="text-xs px-3 py-1.5 bg-amber-700 hover:bg-amber-600 text-zinc-100 rounded disabled:opacity-50">
              {submitting ? "Shipping…" : "Ship"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Build and lint**

Run: `npm run lint && npm run build`
Expected: clean. If `useContractPartnersQuery` doesn't exist under that exact name (Step 1 should have caught this), fix the import to match whatever the actual hook is named before proceeding — don't invent a new query hook for something that already exists.

- [ ] **Step 4: Commit**

```bash
git branch --show-current   # confirm NOT main before committing
git add app/production/components/ExportBayTab.tsx
git commit -m "Add ExportBayTab component"
```

---

### Task 6: Wire `ExportBayTab` into `ExportTab.tsx`, delete the old modal

**Files:**
- Modify: `app/production/components/ExportTab.tsx`
- Delete: `app/production/components/ColdStorageExportModal.tsx`

**Interfaces:**
- Consumes: `ExportBayTab` (Task 5).
- Produces: nothing — UI leaf, last task with code changes.

- [ ] **Step 1: Delete the old modal**

```bash
git rm app/production/components/ColdStorageExportModal.tsx
```

- [ ] **Step 2: Remove `AllocationsTab` and its imports**

In `app/production/components/ExportTab.tsx`, delete the entire `AllocationsTab` function (currently lines 75-198, the full `// ─── Allocations Tab ─────...` section). Also remove the now-unused `BatchAllocation` import (the `import type { BatchAllocation, AllocationChannel, Recipe } from "../types";` line, currently line 7 — keep `AllocationChannel`/`Recipe`, drop `BatchAllocation` since nothing else in this file uses it after `AllocationsTab` is removed) — but first verify with `grep -n "BatchAllocation" app/production/components/ExportTab.tsx` that no other usage remains before removing the import.

- [ ] **Step 3: Replace the `TopTab`/`TOP_TABS` entries**

Replace:
```ts
type TopTab = "allocations" | ExportChannel;

const TOP_TABS: { key: TopTab; label: string }[] = [
  { key: "allocations", label: "Allocations" },
  { key: "taproom", label: "Taproom" },
  { key: "distribution", label: "Distribution" },
  { key: "contract_brewing", label: "Contract Brewing" },
];
```
with:
```ts
type TopTab = "export_bay" | ExportChannel;

const TOP_TABS: { key: TopTab; label: string }[] = [
  { key: "export_bay", label: "Export Bay" },
  { key: "taproom", label: "Taproom" },
  { key: "distribution", label: "Distribution" },
  { key: "contract_brewing", label: "Contract Brewing" },
];
```

- [ ] **Step 4: Add the `ExportBayTab` import and update the root component**

Add near the top of the file, with the other imports:
```ts
import ExportBayTab from "./ExportBayTab";
```

Replace:
```ts
  const [tab, setTab] = useState<TopTab>("allocations");
```
with:
```ts
  const [tab, setTab] = useState<TopTab>("export_bay");
```

Replace:
```tsx
            {key !== "allocations" && (
              <span className="ml-1.5 text-xs text-zinc-600">
                ({exports.filter(e => e.channel === key).length})
              </span>
            )}
```
with:
```tsx
            {key !== "export_bay" && (
              <span className="ml-1.5 text-xs text-zinc-600">
                ({exports.filter(e => e.channel === key).length})
              </span>
            )}
```

Replace:
```tsx
      {tab === "allocations" && <AllocationsTab />}
```
with:
```tsx
      {tab === "export_bay" && <ExportBayTab />}
```

- [ ] **Step 5: Build and lint**

Run: `npm run lint && npm run build`
Expected: fully clean — this is the last task touching code in this plan.

- [ ] **Step 6: Final repo-wide sweep**

Run: `grep -rn "ColdStorageExportModal\|cold-storage-export" app lib --include="*.ts" --include="*.tsx"`
Expected: zero matches.

- [ ] **Step 7: Commit**

```bash
git branch --show-current   # confirm NOT main before committing
git add app/production/components/ExportTab.tsx
git rm app/production/components/ColdStorageExportModal.tsx
git commit -m "Replace Allocations tab with Export Bay, remove old export modal"
```

---

### Task 7: Manual verification

**Files:** none (verification only).

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: nothing — final gate before considering Spec 2b done.

- [ ] **Step 1: Verify the inventory endpoint against live data**

```bash
source .env.local
curl -s "$SUPABASE_URL/rest/v1/cold_storage_inventory?select=recipe_id,packaging_item_id,variant_label,quantity_on_hand" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```
Then hit the route directly (via a local dev server, authenticated) and confirm the grouped totals match a manual sum of the raw rows above.

- [ ] **Step 2: Code-trace a simulated multi-batch Ship request**

Read through `app/api/production/export-bay/ship/route.ts` end to end with a hypothetical example: a customer with two allocations for the same recipe on two different batches (Batch A, created earlier, with 5 BBL remaining; Batch B, created later, with 10 BBL remaining), requesting a quantity that converts to 8 BBL. Confirm the code credits Batch A's allocation fully (5 BBL) and Batch B's allocation partially (3 BBL), produces one `batch_transfers` row per batch, one `export_transactions` row per credited allocation (2 total) sharing one `shipment_id`, and that the two `export_transactions.quantity` values sum to exactly the original requested unit quantity (not just the BBL amounts).

- [ ] **Step 3: Verify the Export Bay tab loads cleanly**

Start the dev server, navigate to Production → Export, confirm the "Export Bay" tab is now the default (no "Allocations" tab present), and that both columns render without console errors (reading live data is fine; do not submit a Ship action against real inventory unless you intend to actually ship something).

- [ ] **Step 4: Verify commitment fulfillment guard**

Read `lib/production/commitmentFulfillment.ts` and confirm: a commitment whose batch is NOT yet `complete` returns early (no fulfillment check attempted), matching the design's explicit rule that fulfillment can't be determined before the batch's final produced volume is known.
