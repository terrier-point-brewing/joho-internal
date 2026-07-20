# Draft-restock phantom export — never drop the excise record

**Date:** 2026-07-19
**Status:** Approved, not yet implemented

## Problem

When a bartender records a keg swap, Square emits a `$0` "Draft Restock" line item per tap. The taproom-consumption sync turns that into a `draft_swap` unit that (a) depletes the linked cold-storage keg and (b) writes an `export_transactions` row. That export row is the **sole source of barrel-excise liability** for the taproom channel (Form B-C-710 sources gallons from `export_transactions`).

Today the export row is a strict downstream side-effect of a *successful physical depletion*, so it silently disappears in two cases — both driven by cold storage being empty:

1. **No stock to deduct.** `recordTaproomConsumption` early-returns when `recordable <= 0` ([recordTaproomConsumption.ts:52](../../../lib/production/recordTaproomConsumption.ts)), so `writeColdStorageShipment` — the only writer of `export_transactions` — is never called. No export → **no excise recorded** (understated tax liability). The `source_ref` is left unstamped for a later retry.
2. **Can't even configure the swap.** The "Cold-storage keg to drain on swap" selector ([DraftStatsTab.tsx:141](../../../app/taproom/components/DraftStatsTab.tsx)) is fed only from *in-stock* cold-storage kegs (`quantity_on_hand > 0` at both [export-bay/inventory/route.ts:43](../../../app/api/production/export-bay/inventory/route.ts) and the component). A recipe with no in-stock keg yields an empty dropdown + "Needs a swap keg", so `swap_variation_id` is never set. At sync time the guard at [taproomConsumption.ts:145](../../../lib/square/taproomConsumption.ts) flags `unconfigured_draft_swap` and `continue`s — no unit, no export.

Failing to record the export (a tax liability) is strictly worse than deducting cold-storage stock that doesn't exist. This change decouples the excise record from the physical depletion: **the swap always books excise for the full swap volume**, whether or not cold storage can back it.

## Decisions (locked with stakeholder)

- **Full swap volume always.** On partial stock, deplete + batch-attribute the covered portion and write a batch-less "phantom" export for the shortfall. Total excise always equals the full keg volume that left the taproom.
- **Cold storage is left untouched for the shortfall — never goes negative.** No depletion occurs for the phantom portion at sync time.
- **Excise records do not require a batch.** A phantom export row carries no `batch_id`.
- **A `short_stock`/phantom event raises a persisted, acknowledgeable alert**, surfaced proactively (in-app count + daily email digest), not only when someone opens the manual sync modal.
- **The alert is actionable:** because there is no physical cold-storage recount mechanism, each open alert exposes a **targeted single-batch depletion** ("Reconcile") to retroactively perform the depletion that never happened, once the missing stock exists.
- **Single-batch reconcile only.** Partial multi-batch reconciliation is a non-goal (see Non-goals).

## Scope

- Taproom `draft_swap` path only. The general `writeColdStorageShipment` and the distribution / contract-brewing export flows are **unchanged** — phantom-on-shortfall is orchestrated in the taproom-specific `recordTaproomConsumption`, not baked into the shared writer.
- No change to how excise is computed (`computeExciseTaxBreakdown`) or to `export_transaction_taxes` child rows — a phantom row taxes its volume exactly like a physical row.

## Schema change (one migration)

`supabase/migrations/<next>_export_transactions_phantom.sql` (next sequential after `20260804_tax_bank_account.sql`), altering `export_transactions`:

- `batch_id` → **drop `NOT NULL`** (currently `NOT NULL` FK → `brew_batches`, defined in `20260622_export_transactions.sql`). FK stays for real rows; `NULL` = no source batch.
- Add `is_phantom boolean NOT NULL DEFAULT false` — explicit discriminator. Every existing/physical row stays `false`.
- Add `alert_acknowledged_at timestamptz NULL` — alert lifecycle. `is_phantom = true AND alert_acknowledged_at IS NULL` ⇔ an open alert.
- Add `alert_emailed_at timestamptz NULL` — daily-digest dedupe (Piece 4). One digest send per alert.

No backfill: all historical rows default to `is_phantom = false`, with `alert_acknowledged_at`/`alert_emailed_at` `NULL` (irrelevant while `is_phantom = false`).

**`batch_id`-nullable blast-radius audit (mandatory task).** Every consumer that joins or groups on `export_transactions.batch_id` must be checked so a `NULL` batch never silently drops a phantom row via an INNER JOIN. Known touch points to verify: financials aggregation, B-C-710 excise gallon sourcing (reads `volume_bbl`/`total_excise_tax_usd` directly — expected safe), and `checkAndCompleteBatch` ([shipmentWriter.ts:140](../../../lib/production/shipmentWriter.ts), only ever called with a real `batchId`). Report findings before merging.

## Piece 1 — Selector always offers a keg

Repoint the "Cold-storage keg to drain on swap" dropdown from in-stock cold storage to **all active keg-type packaging variations linked to the recipe**, regardless of stock.

- **Source:** `recipe_packaging_variations` filtered by `recipe_id`, embedding `packaging_variations!inner(${PACKAGING_VARIATION_SELECT})` with `is_active = true`, keeping rows where `container.type === "keg"`. Mirror [recipe-packaging-variations/route.ts](../../../app/api/production/recipe-packaging-variations/route.ts) (add/confirm a `recipe_id` filter). Full-keg volume = `packaging_variations.total_volume_fl_oz`.
- **`DraftStatsTab.tsx`:** feed `kegOptionsByRecipe` from this source instead of `/api/production/export-bay/inventory`. When on-hand stock exists, keep the "(N on hand)" hint by cross-referencing the existing cold-storage query (still fetched for display); when it doesn't, the option is still selectable with no hint. `swap_volume_fl_oz` is derived from the selected variation's coded volume exactly as today. "Needs a swap keg" now means only "no keg variation configured", not "out of stock".

## Piece 2 — Phantom export write path

**New `writePhantomExport(...)`** — batch-less sibling of the physical writer, new file `lib/production/writePhantomExport.ts`:

```ts
export async function writePhantomExport(
  supabase: SupabaseClient,
  params: {
    shipmentId?: string;   // reuse the physical shipment when one exists; else create one
    recipeId: string;
    variationId: string;   // the swap packaging variation
    quantityKegs: number;  // the shortfall, in kegs
    sourceRef: string;     // sqtransfer:orderId:lineUid — same key as the physical rows
    notes?: string | null;
  },
): Promise<{ exportTransactionId: string; shipmentId: string }>
```

- Fetch the variation's `total_volume_fl_oz`, `container_id`, `name`, `format` (as [shipmentWriter.ts:71](../../../lib/production/shipmentWriter.ts) does).
- `volume_bbl = quantityKegs * total_volume_fl_oz / BBL_TO_FL_OZ` (`BBL_TO_FL_OZ = 3968`, [lib/constants/production.ts:2](../../../lib/constants/production.ts)).
- Reuse `writeExportTransaction` ([exportTransactionWriter.ts](../../../lib/production/exportTransactionWriter.ts)) to insert the row + `export_transaction_taxes`, with: `batch_id: null`, `is_phantom: true`, `allocation_id: null`, `source_transfer_id: null`, `channel: 'taproom'`, `status: 'paid'`, `packaging_item_id = variation.container_id`, `variant_label` from the variation, `quantity = quantityKegs`, `volume_bbl`, `source_ref`. `writeExportTransaction` gains an `isPhantom?: boolean` param and accepts a nullable `batchId`.
- **No `cold_storage_inventory` write.** Creates a shipment row when `shipmentId` is not supplied (mirroring how `writeColdStorageShipment` creates its shipment); otherwise attaches to the passed shipment.

**`recordTaproomConsumption` orchestration** ([recordTaproomConsumption.ts](../../../lib/production/recordTaproomConsumption.ts)) — replace the `if (recordable <= 0) return` early-out:

1. `recordable = min(quantity, available)`; `shortfall = quantity - recordable`.
2. If `recordable > 0`: `writeColdStorageShipment(recordable)` as today → shipment + batch-attributed physical rows. Capture its `shipmentId`.
3. If `shortfall > 0`: `writePhantomExport({ shortfall, shipmentId: <physical shipment id or undefined> })`. When `recordable == 0`, `writePhantomExport` creates its own shipment; the whole line is phantom.
4. Return `recordedQty = recordable`, `shortfallQty = shortfall`, `exportTransactionIds = [...physical, ...phantom]`, plus `breaks`/`warnings`.

**Idempotency (unchanged mechanism, now covers phantom).** [taproomConsumptionSync.ts](../../../lib/production/taproomConsumptionSync.ts) sums recorded `quantity` per `source_ref` from `export_transactions`. Phantom rows carry the same `source_ref`, so total-recorded = full swap `quantity` → a re-sync computes delta 0 → skips. The old "leave `source_ref` unstamped to retry when stock arrives" behavior is intentionally removed (we record immediately). Reconciliation of the physical depletion now happens through the alert (Piece 3), not through a later automatic retry.

**Recount fires on phantom swaps.** The Square draft-SKU recount ("a fresh keg is now on tap") is gated on `recordedQty > EPS && alreadyRecorded === 0` ([taproomConsumptionSync.ts:176](../../../lib/production/taproomConsumptionSync.ts)). A phantom swap is still a real fresh keg, so change the gate to fire when the unit was **newly recorded this run (physical OR phantom)** — i.e. `alreadyRecorded === 0 && (recordedQty + shortfallQty) > EPS`. **Shrinkage capture stays tied to physical `recordedQty`** — no real inventory moved on a phantom swap, so there is nothing to reconcile; confirm this default against the shrinkage logic during implementation and note if it needs to change.

## Piece 3 — Actionable alert (reconcile / dismiss)

The phantom export row **is** the persisted alert (`is_phantom = true`, `alert_acknowledged_at IS NULL` = open). No parallel alerts table.

**Reconcile route** — `POST /api/production/taproom-consumption/reconcile-phantom`, body `{ exportTransactionId, batchId }`:

1. Load the phantom export → `recipe_id`, `variation_id`, `quantity`. Reject if not `is_phantom` or already acknowledged.
2. Validate `batchId` is the same `recipe_id` **and** has `>= quantity` on-hand in that variation's cold storage. Reject (400) otherwise — never deplete below zero.
3. **Targeted depletion** of `batchId` + `variation_id` for `quantity` units. Needs a batch-targeted variant of [`depleteColdStorageInventory`](../../../lib/production/coldStorageDepletion.ts) (today oldest-first) — add a `batchId?` param that restricts depletion to one batch's lot.
4. **No new export / no new excise** — the excise is already on the phantom row. Pure inventory true-up.
5. Backfill `batch_id` on the phantom row to `batchId` (now traceable to the lot that covered it) and set `alert_acknowledged_at = now()`. `is_phantom` **stays true** — permanent audit fact that excise was booked before stock existed. Run `checkAndCompleteBatch(batchId)` after depletion, consistent with the physical path.

**Dismiss route** — `POST /api/production/taproom-consumption/dismiss-phantom`, body `{ exportTransactionId }`: sets `alert_acknowledged_at = now()` with no depletion, for swaps where there genuinely was no cold-storage keg to draw down (keg went straight to tap, never received into cold storage).

Both routes: manager+ role via `getSessionUser` / existing auth; admin Supabase client (finance/production write context).

**UI — Export Bay tab** ([ExportBayTab.tsx](../../../app/production/components/ExportBayTab.tsx)), mirroring Finance's `DataQualityPanel` "⚑ N to review" pattern:

- A count indicator: "N draft swaps recorded without cold-storage stock" (count of open phantom alerts), hidden/"all reconciled" when zero.
- Opens a list; each row shows beer / tap / date / kegs / volume, a **batch picker** (batches of that recipe with `>= quantity` on-hand in the variation), a **Reconcile** button (enabled only when an eligible batch is selected), and a **Dismiss** button. Rows with no eligible batch show only Dismiss until stock appears.
- New read endpoint (or extend an existing production endpoint) returning open phantom alerts + eligible batches per alert.

## Piece 4 — Daily email digest

Mirror the `tax_tasks` alert pattern (idempotent, dedupe via a sent-timestamp, `lib/resend.ts` + `ADMIN_EMAIL`):

- Extend the existing **taproom-consumption cron** ([cron/taproom-consumption-sync/route.ts](../../../app/api/cron/taproom-consumption-sync/route.ts)) — after the sync, query open phantom alerts whose `alert_acknowledged_at IS NULL` and that have not yet been emailed, and send one digest listing them (beer / tap / date / kegs / volume / excise). Reuse the `runCronJob` wrapper.
- **Dedupe:** add `alert_emailed_at timestamptz NULL` to `export_transactions` in the same migration; the digest selects `is_phantom AND alert_acknowledged_at IS NULL AND alert_emailed_at IS NULL`, stamps `alert_emailed_at` after a successful send. (One-shot notification per alert; the in-app count is the ongoing surface.) Acknowledging clears nothing — an emailed-but-unacknowledged alert still shows in-app until reconciled/dismissed.
- New helper module `lib/production/phantomExportAlerts.ts` (query open/unemailed alerts, `markEmailed`) + `lib/production/phantomAlertEmail.ts` (render), analogous to `lib/tax/tasks.ts` + `lib/tax/alertEmail.ts`.

## Data flow (one line)

`webhook / cron` → `runTaproomConsumptionSync` → `recordTaproomConsumption` → { `writeColdStorageShipment` (physical, depletes) **and/or** `writePhantomExport` (phantom, no deplete) } → `export_transactions` (+ `is_phantom`) → Export Bay alert list + daily digest → `reconcile-phantom` (targeted deplete + acknowledge) or `dismiss-phantom` (acknowledge).

## Edge cases

- **Zero stock:** whole line is phantom; `writePhantomExport` creates its own shipment; recount still fires; alert opens.
- **Partial stock:** physical rows for the covered kegs (depletes) + one phantom row for the shortfall (no deplete), under one shipment. Excise = full volume.
- **Re-sync / duplicate webhook:** `source_ref` idempotency counts phantom quantity, so no double-write.
- **Reconcile against a batch without enough on-hand:** rejected (400); alert stays open. Never goes negative.
- **>1-keg restock line with no single batch covering it:** alert stays open with only Dismiss available; true up manually. (No partial multi-batch — see Non-goals.)
- **Dismiss then stock arrives:** alert is closed; the stock is simply never drawn down by this swap (cold storage stays overstated by that keg until an unrelated adjustment) — the accepted consequence of "leave cold storage untouched".
- **Manual sync modal:** the existing ephemeral `short_stock` discrepancy still renders there, unchanged.

## Consequence to accept (documented, not a bug)

When a shortfall was caused by a *missing kegging entry* (the common case), the excise is booked immediately (correct for tax) but cold storage is not depleted. Once the kegging entry is fixed and stock exists, the operator closes the loop via **Reconcile** (targeted depletion). Until they do, cold storage is overstated by that keg. The open, emailed alert is the mechanism that drives that true-up; there is no automatic re-depletion.

## Testing

Per the repo's co-located `lib/` test rule:

- `lib/production/writePhantomExport.test.ts`: volume/excise math (`kegs × fl_oz / 3968`), `batch_id: null` + `is_phantom: true`, tax children written, shipment created when none passed / reused when passed.
- `lib/production/recordTaproomConsumption.test.ts`: zero-stock → phantom only, no depletion; partial → physical (depletes) + phantom (no deplete), volumes sum to full; full stock → unchanged (no phantom); idempotent re-run → no double count.
- Recount-gate test: phantom-only swap still triggers the recount branch; shrinkage capture does not.
- `depleteColdStorageInventory` targeted-batch variant: depletes only the named batch; refuses to exceed on-hand.
- Reconcile/dismiss route logic: reconcile validates recipe+on-hand, backfills `batch_id`, sets `alert_acknowledged_at`, keeps `is_phantom`; dismiss acknowledges without depleting; both reject already-acknowledged rows.
- `phantomExportAlerts` digest selection + `markEmailed` dedupe.
- `batch_id`-nullable consumer audit (findings, not a unit test).

## Non-goals

- No change to the shared `writeColdStorageShipment` or to distribution / contract-brewing export flows.
- No partial / multi-batch reconciliation (single batch must cover the full line quantity; rare >1-keg lines fall back to Dismiss + manual adjustment).
- No automatic re-depletion when stock later arrives — reconciliation is an explicit operator action.
- No nav-level badge (no precedent in `NavBar.tsx`); the count lives in the Export Bay surface.
- No change to `is_phantom` on reconcile — it remains a permanent origin marker.
