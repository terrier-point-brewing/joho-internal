# Spec 9: Packaging Usage Audit + Logic-Gap Fixes

## Background

While brainstorming the originally-planned Spec 9 (splitting `packaging_items` into containers vs. components — see "Active situation" in `docs/superpowers/ROADMAP.md`), the user requested a new prerequisite spec: an end-to-end audit of how `packaging_items` is actually used across the production flow, fixing any logic gaps found, before touching the schema. This spec is that audit. The container/component table split becomes Spec 10, blocked on this spec.

## Goal

Read every consumer of `packaging_items` in the codebase, confirm each one behaves correctly against the real data flow (not just against its own local assumptions), and fix any logic gaps found. This de-risks Spec 10's schema split by ensuring the code being migrated is already correct.

## Scope: consumers to audit

All 8 areas identified by survey, each gets a pass during plan-writing/implementation:

1. **Cold storage inventory** — `cold_storage_inventory` table, `upsertColdStorageInventory()`, `app/api/production/export-bay/{inventory,ship,ship-adhoc}/route.ts`
2. **Kegging/canning transfers** — `app/api/production/transfers/route.ts` (packaging deduction + cold storage write), `ExportBayTab.tsx` (transfer creation UI)
3. **Stock adjustments** — `packaging_stock_adjustments` table, `app/api/production/packaging-adjustments`, `StockAdjustmentsTab.tsx`
4. **Commitment packaging preferences** — `commitment_packaging_preferences` table, `CommitmentsTab.tsx`, `app/api/production/contract-requests/route.ts`
5. **Recipe ↔ Square links** — `recipe_square_links` table, `SquareLinkManager.tsx`, `app/api/production/recipe-square-links/route.ts`
6. **Demand calendar / batch scheduler** — `app/api/production/demand-calendar/route.ts`, `app/api/production/batch-scheduler/route.ts`
7. **Export Settings: Packaging Fee mapping** — `export_service_mappings`, `ExportSettingsPanel.tsx`, `app/api/production/export-settings/service-mappings/route.ts`
8. **Packaging CRUD UI** — `app/api/production/packaging/[route,[id]/route].ts`, `PackagingTab.tsx`

## Confirmed issues (in scope, fix directly)

**Issue 1 — Packaging Fee mapping shows components, not just containers.**
`ExportSettingsPanel.tsx:248`, `PackagingFeeSection`, maps over the full `usePackagingQuery()` result with no type filter. Live data has 5 container rows (`type` in `keg`, `can`) and 3 component rows (`lid`, `paktech`, `tray`) — the section renders 8 mapping rows instead of 5.
**Fix**: filter to `pkg.type === "keg" || pkg.type === "can"` before mapping. (Spec 10 will replace this with a join to the new containers table; this is the immediate correctness fix that doesn't require the schema change.)

**Issue 2 — Demand calendar uses a guessed proxy instead of the real packaging item per lot.**
`app/api/production/demand-calendar/route.ts:73-81` builds `packagingByBatchTransfer` by looking up "the default packaging item for this lot's type" (`typedPkg.find(p => p.type === lot.packaging && p.is_default)`), with a comment stating `batch_transfers` doesn't store `packaging_item_id` so this is a "proxy." But `cold_storage_inventory` (added in Spec 1, after this code was written) already stores the real `packaging_item_id` per lot, written by `upsertColdStorageInventory()` at transfer time (`transfers/route.ts:76-79`, `:116-119`). `coldStorageLots()` (`app/production/lib/coldStorage.ts`) builds lots from raw `batch_transfers` and never joins `cold_storage_inventory`, so the real id is available but unused.
**Fix**: join `cold_storage_inventory` (keyed by `source_transfer_id`) when building lots, or pass its `packaging_item_id` through to `packagingByBatchTransfer` directly, removing the type+is_default guess. Read `app/production/lib/coldStorage.ts` in full before changing it — confirm `coldStorageLots()`'s existing signature/contract and whether other callers besides `demand-calendar` depend on its current (transfer-only) shape.

## Audit procedure for the remaining 6 areas

For each, during plan-writing: read the consumer's full current code, trace the actual data written/read end-to-end (not just the local function), and check for:
- Stale comments/TODOs implying a known gap (as found in Issue 2)
- Joins that silently fall back to a guess instead of using data that already exists elsewhere
- Type-filtering omissions similar to Issue 1 (anywhere `packaging_items` is queried without filtering by `type` when the context only wants containers or only wants components)
- Non-atomic stock_quantity read-then-write (`transfers/route.ts:66-69`, `:103-106`) — confirm whether concurrent transfers are a real risk given this app's usage pattern (single-location taproom, low transfer concurrency) before deciding whether to fix; if it's a real risk, switch to an atomic `update ... set stock_quantity = stock_quantity - $1` instead of fetch-then-write.

Any additional issue found gets fixed in the same implementation pass and documented in the plan/PR, same bar as Issues 1-2.

## Out of scope

- The container/component table split itself (Spec 10).
- BOM/assembly modeling between containers and components — confirmed not needed: `transfers/route.ts`'s `canning_detail` already requires the UI to explicitly pass each component's `packaging_item_id` (`lid_packaging_id`, `paktech_packaging_id`, `tray_packaging_id`, `label_packaging_id`) per transfer; there's no implicit "pick the default" assembly logic to replace.
- Any new packaging types/categories beyond the existing 6 (`keg`, `can`, `lid`, `paktech`, `tray`, `label`).

## Success criteria

- `npm run lint` + `npm run build` clean.
- Issues 1 and 2 fixed and verified via direct REST check against live data (Packaging Fee mapping shows exactly 5 rows; demand calendar's per-lot packaging resolves to the actually-used item, not a type default, for at least one multi-packaging-type batch in the live data if one exists — otherwise verified by code trace plus a manual cold-storage transfer test).
- Audit findings for the remaining 6 areas documented in the PR description, whether or not they required a fix.
