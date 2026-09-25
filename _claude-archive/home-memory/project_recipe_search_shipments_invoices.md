---
name: project_recipe_search_shipments_invoices
description: "PR #297 MERGED (2026-07-29) added recipe search to Shipments + Export Invoices; no migration; layout never seen in a browser"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5b824a70-34ba-4462-a1fa-6dfc1d8ff3b3
  modified: 2026-07-29T22:08:29.552Z
---

**PR #297 MERGED** 2026-07-29 as squash `93329b5` (verified present on `origin/main` with all 3 files, 57/5 lines). **No migration, no schema change** — nothing gated on a prod apply. Worktree + branch cleaned up after merge.

Adds a "Search recipe…" box to `ShipmentsTab` (which had no search box at all) and a **second** box to `ExportInvoicesTab` beside its invoice-# box. URL params `ship_q_recipe` / `inv_q_recipe`. A card/invoice matches when ANY rolled-up line is that beer, and the whole card then renders intact — matching how the existing categorical filters behave.

Also added `recipe_id` + `recipes(beer_name)` to the invoices route shipment embed (normalized to `recipe_beer_name`), mirroring `/api/production/exports`. **This is a no-op for current data** — all 75 invoiced shipment lines have a batch, so the recipe fallback never fires. Kept as insurance for batchless lines (draft recounts, phantoms) which would otherwise be unsearchable AND blank in the Included Shipments table. See [[project_export_bay_false_all_reconciled]], [[project_draft_restock_phantom_export]].

⚠️ **REMAINING: layout never seen in a browser** (login wall again — cannot enter credentials). Export Invoices now has two 256px `SearchInput`s plus three `FilterSelect`s. `FilterBar` is `flex-wrap`, so worst case the Year filter wraps to a second line — cosmetic. Check when signed in. Same login-wall gate as [[project_floorplan_batchlog_export_fixes]] and [[project_filterbar_phantom_wrap]] (that one is the reason to actually look: `.inp-sm` width bugs in this exact bar have caused phantom wrapping before).

**Durable:** `docs/UI_STANDARD.md:319` forbids blending entities in one search box — "Different entities → separate controls." Invoice # OR recipe in one box is a violation; recipe gets its own box. The array-accessor blend is only for *one entity's own identity fields* (item + variation, account # + name).

**Durable:** verifying a PostgREST embed is cheap and worth doing — `curl` the REST endpoint with the exact select string using `SUPABASE_SERVICE_ROLE_KEY` from `.env.local`. A bad FK embed returns PGRST200 *before* RLS row filtering, so even a filtered query proves the embed resolves. This route has 500'd on that class of bug before ([[project_packaging_variations_breaks_into_embed]], [[project_migration_drift_brew_activities]]).

**Durable:** when the login wall blocks UI verification, the pure logic is still testable against real data — capture the route's payload via `curl`, then run the component's exact accessors through `applyControls` in a throwaway `*.test.ts`, and delete it before committing. Proves no-false-positive/no-false-negative behavior that a screenshot wouldn't.
