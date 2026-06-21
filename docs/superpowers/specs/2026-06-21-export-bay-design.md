# Export Bay UI

**Spec 2b of the Invoicing / Kegging-Canning / Cold Storage / Export feature roadmap:**
1. Cold Storage + Transfer Log schema (Spec 1 — merged)
2. Export Transaction model + batch-completion automation (Spec 2a — merged)
3. **Export Bay UI** (this spec)
4. Export > Commitments unified invoicing (Packaging Fees / Bulk Discount / Excise / Keg Cleaning / Forklift) — depends on this spec
5. Ad-hoc exports + allocation-adjustment/refund flow (Spec 2c) — depends on this spec
6. Export Settings + Barrel Excise Tax settings (mirrored to Finance > Settings) — depends on Spec 5

## Problem

There is no persistent "Export Bay" screen today. The only export-creation UI is `ColdStorageExportModal.tsx`, which is fully built (FIFO inventory computation, channel/recipient routing, tax calc) but **unwired — no button anywhere triggers it**. It also computes inventory by parsing `batch_transfers` jsonb (FIFO-over-transfers), even though Spec 1 built `cold_storage_inventory` specifically to replace that computation, and Spec 2a's export route never switched over.

Separately, there's no way today to see, at a glance, "what's available to ship" next to "who still needs what" — the existing Allocations tab shows fulfillment status per allocation, but doesn't help a user decide what to actually ship.

## Goals

- Build a 2-column Export Bay screen: available cold-storage inventory (by recipe + packaging variant, summed across batches) next to active allocations (grouped by Customer + Recipe, each showing its own `desired_delivery_date` and fulfillment progress).
- Replace the inventory-depletion write path with direct `cold_storage_inventory` consumption, retiring the FIFO-over-jsonb computation in `ColdStorageExportModal`/`cold-storage-export/route.ts` entirely (both get deleted — confirmed unused/unwired, no migration concern).
- Decouple **inventory depletion** (which physical batch's kegs leave cold storage — FIFO by `cold_storage_inventory.created_at`, invisible to the user) from **allocation crediting** (which customer/batch allocation gets marked closer to fulfilled — FIFO by batch creation order, same direction, but a logically separate decision). A single Ship action can therefore produce multiple `export_transactions` rows (different `batch_id`/`allocation_id`, one shared `shipment_id`) when a customer's need spans more than one of their allocations for that recipe.
- Automate Commitment fulfillment: once an allocation's batch reaches `complete` (so `allocated_bbl` is no longer a moving target) and `exported_bbl >= allocated_bbl`, set the linked `commitments.status = 'fulfilled'`.

## Non-Goals

- **Ad-hoc exports** (shipping to a customer/recipe with no existing allocation) — Spec 2c.
- **Allocation adjustment + refund flow** (modifying a locked allocation, financial alert, refund trigger) — Spec 2c.
- **Invoice generation** from shipped Export Transactions — Spec 3 (Export > Commitments unified invoicing).
- Anything for the `taproom` channel — taproom allocations have no `partner_id` (no specific customer; it's inventory pushed to the public-facing POS, already synced to Square separately) and are excluded from this screen's Customer+Recipe grouping entirely.
- Excise tax *rate configuration* UI — unchanged from Spec 2a; this spec only consumes `excise_tax_rates`, doesn't manage it.

## Architecture

**New tab**: `ExportTab.tsx` already renders a top-level tab bar (`TOP_TABS`: Allocations, Taproom, Distribution, Contract Brewing) with client-side switching inside one page (`app/production/export/page.tsx`) — no separate route per tab. This spec adds `"export_bay"` to that same `TopTab` union and `TOP_TABS` array, rendering a new `ExportBayTab` component alongside the existing ones, matching the established convention exactly rather than introducing a new route.

**Left column — "Available"**: queries a new endpoint that groups `cold_storage_inventory` by `(recipe_id, packaging_item_id, variant_label)`, summing `quantity_on_hand` across every batch. No batch breakdown is shown — the user only ever sees a single number per recipe+variant.

**Right column — "Allocations"**: extends the existing `/api/production/allocations` GET (already returns `produced_bbl`, `allocated_bbl`, `exported_bbl`, `fulfilled` per allocation row) by joining `commitments.desired_delivery_date` via `batch_allocations.contract_request_id`, and excluding `channel = 'taproom'` rows. The client groups these rows by `partner_id + recipe_id` into a visual "Customer needs Recipe X" header (aggregating `allocated_bbl`/`exported_bbl` for the header's summary line), with each underlying allocation row displayed beneath showing its own batch, `desired_delivery_date`, and fulfillment state — so a customer with allocations spanning two batches of the same recipe shows two rows under one header, not one merged row.

**Ship action**: a form (opened from a Customer+Recipe header, or a standalone control — exact placement at implementation time) collecting `partner_id`, `recipe_id`, `packaging_item_id`, `variant_label`, `quantity`, optional `notes`. Submits to a new endpoint replacing the old export route.

## Data Model

No new tables. This spec is pure read/write logic against tables Specs 1 and 2a already created:
- `cold_storage_inventory` (read for the left column's grouped sum; written/decremented by the Ship endpoint).
- `batch_allocations` + `commitments` (read for the right column, including the new `desired_delivery_date` join).
- `export_transactions` + `export_transaction_taxes` (written by the Ship endpoint — `allocation_id` gets populated for the first time, closing the gap Spec 2a deliberately left open).
- `brew_batches.status` (read by the new commitment-fulfillment check).

## API Changes

### `GET /api/production/export-bay/inventory` (new)

Returns the left column's data:
```ts
interface AvailableInventoryLine {
  recipe_id: string;
  recipe_name: string;
  packaging_item_id: string;
  variant_label: string;
  quantity_on_hand: number;
}
```
Query: `select recipe_id, recipes(beer_name), packaging_item_id, variant_label, sum(quantity_on_hand) from cold_storage_inventory group by recipe_id, packaging_item_id, variant_label having sum(quantity_on_hand) > 0`.

### `GET /api/production/allocations` (no backend change)

The existing select in `allocations/route.ts` already joins `commitments(id, beer_style, volume_bbl, desired_delivery_date, ...)` — `desired_delivery_date` is already present in every response row. No backend change needed here. `ExportBayTab` calls this same endpoint and filters out `channel === "taproom"` client-side before grouping by `partner_id + recipe_id` — consistent with how `ExportTab.tsx`'s other tabs already filter the shared `exports`/`allocations` query results client-side by channel rather than adding query params.

### `POST /api/production/export-bay/ship` (new, replaces `cold-storage-export`)

Request:
```ts
interface ShipRequest {
  partner_id: string;
  recipe_id: string;
  packaging_item_id: string;
  variant_label: string;
  quantity: number;
  notes?: string | null;
}
```

Logic:
1. **Validate availability**: sum `cold_storage_inventory.quantity_on_hand` for `(recipe_id, packaging_item_id, variant_label)` across all batches; reject if `quantity` exceeds it.
2. **Validate allocation coverage**: fetch this `partner_id`'s `batch_allocations` for `recipe_id` (via `brew_batches.recipe_id = recipe_id`), excluding `taproom`; compute each one's remaining BBL (`allocated_bbl - exported_bbl`, with `allocated_bbl` still possibly null if `produced_bbl` is unknown — null/pending allocations are skipped, not crediting candidates); convert `quantity` (units) to BBL using `packaging_items.volume_fl_oz`; reject if total requested BBL exceeds the sum of remaining BBL across all that customer's eligible allocations for this recipe (this is the "no ad-hoc shipping" guard — Spec 2c relaxes this).
3. **Inventory depletion**: decrement `cold_storage_inventory.quantity_on_hand` for `(recipe_id, packaging_item_id, variant_label)`, oldest `created_at` row first, until `quantity` is exhausted (may span multiple batch rows; delete a row if it hits exactly 0, per the table's existing upsert convention from Spec 1).
4. **Allocation crediting**: order the eligible allocations from Step 2 by their batch's creation order (oldest first — same direction as Step 3's FIFO), credit the shipped BBL sequentially until exhausted (last allocation absorbs any rounding remainder). For each allocation credited, insert one `export_transactions` row: `batch_id` = that allocation's batch, `allocation_id` = that allocation's id, `recipe_id`, `packaging_item_id`, `variant_label`, `quantity` = the portion (in units, derived back from the BBL portion credited) attributable to that allocation, `volume_bbl` = that portion's BBL, `channel` = that allocation's `channel`, `recipient_id` = `partner_id`, `notes`. All rows from this request share one generated `shipment_id`.
5. **Tax breakdown**: call `computeExciseTaxBreakdown` (from Spec 2a, unchanged) per `export_transactions` row using that row's own `volume_bbl`; insert `export_transaction_taxes` rows; set `total_excise_tax_usd` per row.
6. **Batch completion**: call `checkAndCompleteBatch` (from Spec 2a, unchanged) once per distinct `batch_id` touched.
7. **Commitment fulfillment** (new): for each allocation credited, re-fetch its batch's current `status` and its own updated `exported_bbl`/`allocated_bbl`; if `status === 'complete'` and `exported_bbl >= allocated_bbl`, update `commitments.status = 'fulfilled'` for that allocation's `contract_request_id` (if not already `'fulfilled'`).

### Retired

- `app/production/components/ColdStorageExportModal.tsx` — deleted.
- `app/api/production/cold-storage-export/route.ts` — deleted, replaced by `export-bay/ship`.

## Edge Cases

- **Quantity exceeds available inventory**: reject with `requested X, available Y`.
- **Quantity exceeds the customer's total remaining allocation for that recipe**: reject — this is the explicit "no ad-hoc shipping" boundary for this spec; Spec 2c relaxes it.
- **Customer has no allocation at all for that recipe** (even though inventory exists): the Ship form simply has no eligible target — this is exactly the ad-hoc case, deferred to Spec 2c.
- **Rounding across multiple credited allocations**: last allocation absorbs the remainder, so the sum always reconciles exactly to the shipped quantity — same convention as Specs 1/2a.
- **Customer has allocations across different channels for the same recipe** (e.g. one `contract_brewing` + one `distribution`): a single Ship action can produce `export_transactions` rows with different `channel` values if crediting spans both — expected, not an error.
- **Locked allocations**: still normal crediting candidates — locking only matters for the adjustment/refund flow (Spec 2c), not eligibility to receive a shipment.
- **Volume conversion simplification**: `cold_storage_inventory.packaging_item_id` is a real FK (Spec 1), so volume comes directly from `packaging_items.volume_fl_oz` — the old `kegNameToBbl` string-parsing fallback is no longer needed anywhere in this flow and is not carried forward.

## Testing

No test runner exists in this repo (consistent with Specs 1/2a) — verification is `npm run lint` / `npm run build`, per-task code review, and a manual dry-run/live-API-check walkthrough. Given there's no staging environment, any live Ship action against real inventory during verification should be explicitly opted into (same caution applied in Specs 1/2a), not assumed.
