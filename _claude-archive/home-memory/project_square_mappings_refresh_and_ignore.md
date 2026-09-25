---
name: project_square_mappings_refresh_and_ignore
description: "2026-07-23 Square item-mappings grid — refresh-from-Square button, auto-refresh on load, ignore-a-mapping capability"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9a00f0d5-f612-438a-8665-4705adabd75e
  modified: 2026-07-24T02:48:05.129Z
---

Square Item Mappings grid (`app/production/settings/square-links/`, also mounted at Taproom Settings) gained three features. **PR #257 OPEN.**

1. **Refresh from Square** button — reuses `POST /api/finance/sync-catalog` (full catalog re-sync), then invalidates grid + `queryKeys.production.squareCatalog()`. Shows "Catalog synced Xm ago" from new `catalogSyncedAt` on the grid payload (= `max(synced_at)` over `square_catalog_variations`).
2. **Auto-refresh on load** — `useSquareMappingGridQuery` set to `staleTime:0` + `refetchOnMount:"always"` (suggestions are recomputed server-side on every fetch; never persisted).
3. **Ignore a mapping** — new table `recipe_square_link_ignores` (draft=`(recipe_id)`, keg/can=`(recipe_id,variation_id)` — same cell grain as links). `buildGrid` gained a 6th arg `ignores` and nulls the suggestion for ignored cells, so they drop out of the high-confidence banner, "Fill all" auto-fill, and the red warning chip automatically. Priority: **linked > ignored > suggestion > warning**. New route `POST/DELETE /api/production/recipe-square-link-ignores` (role brewer/manager, idempotent upsert). Ignore surfaced in `MappingDrawer` (muted "Ignored" panel + "Require mapping" to un-ignore); grid shows muted grey "Ignored" chip. Link-create clears any stale ignore (invariant: never both linked+ignored).

⚠️ **HARD deploy gate — migration `20260814_recipe_square_link_ignores.sql` is HUMAN-GATED / NOT applied.** `lib/production/mappingGridData.ts` `fetchMappingGrid` now queries `recipe_square_link_ignores`; that fn is SHARED by `/api/taproom/inventory` too. So deploying this code before applying the migration **500s BOTH the mappings grid AND taproom inventory grid.** Verified locally: grid `GET ...?grid=1` returns 500 until the table exists (local `.env.local` → prod Supabase). Browser smoke blocked solely by this; logic covered by tests.

Verify green (1835 tests, 0 lint errors). Spec/plan in `docs/superpowers/{specs,plans}/2026-07-23-square-mappings-refresh-and-ignore*`. Related: [[project_sku_mapping_consolidation]], [[project_ghost_duplicate_packaging_variation_links]], [[project_migration_drift_brew_activities]] (unapplied-migration 500 failure mode).
