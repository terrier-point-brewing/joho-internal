---
name: project_draft_swap_keg_generic_options
description: "2026-07-22: Draft-stats \"Keg to drain on swap\" dropdown was blank for every tap — house beers drain generic (partner_id null) house kegs that have no recipe_packaging_variations link, but the dropdown only listed recipe-linked kegs."
metadata: 
  node_type: memory
  type: project
  originSessionId: 6c6da304-bb3f-49f8-a969-6b5d4ab5e48c
  modified: 2026-07-22T17:14:16.691Z
---

2026-07-22: On Taproom > Performance > Draft Stats, the **"Keg to drain on swap"** dropdown (edit/"Configure taps" mode) was blank for all 14 taps. Root cause was option-sourcing, NOT missing data: every tap stored a valid swap keg (`tap_assignments.swap_variation_id` = the generic "1/6 Keg" `4ddbce98…`, active, `partner_id=null`), but `DraftStatsTab.tsx`'s `kegOptionsByRecipe` was built ONLY from `recipe_packaging_variations`. The three generic house kegs (`1/2`/`1/4`/`1/6 Keg`, all `partner_id=null`) have NO recipe→keg link — only contract-partner kegs (Fortnight-, Local Time-) are recipe-linked — so the stored generic keg had no matching `<option>` and the `<select>` rendered blank (+ false "Needs a swap keg" hint).

**REVISED APPROACH (final, on PR #236):** the first fix (surfacing generic kegs in DraftStatsTab client code via `genericKegOptions`/`kegsForRecipe`) was REVERTED — it keyed on-hand by `variation_id` alone, so the shared generic keg showed the SAME "N on hand" on every tap (user reported "every draft swap showing 8 on hand"). Correct fix = make generic kegs REAL per-recipe links:
1. **Migration `20260812_backfill_generic_kegs_to_recipes.sql`** — links generic house kegs (keg container, `partner_id=null`, `is_active`) to EVERY existing recipe via `recipe_packaging_variations` (idempotent NOT-EXISTS insert-from-select). ⚠️ PENDING prod apply (Supabase MCP unauthenticated this session).
2. **`app/api/production/recipes/route.ts` POST** — auto-links generic kegs on new recipe via shared **`getGenericKegVariationIds(supabase)`** helper in `lib/production/packagingVariations.ts`.
3. **`DraftStatsTab.tsx`** — back to listing ONLY explicitly-linked kegs (`kegOptionsByRecipe.get(...)`); on-hand hint now keyed by **`recipe_id|variation_id`** (`onHandByRecipeVar`), mirroring the draft-stats route (which already keyed this way, lines 38-45, and comments that variation alone sums every recipe's kegs).

**Durable fact:** generic house kegs (1/2 `ac4f3b17`, 1/4 `b5e96203`, 1/6 `4ddbce98`; all `partner_id=null`) are shared across beers. Cold-storage on-hand for them MUST be keyed by (recipe, variation) — never variation alone. Contract-partner kegs (Fortnight `4cb56ba6`, Local Time `4afa5a8d`) are recipe-specific.

**Why:** house kegs aren't recipe-specific but are drained per-recipe from cold storage; keying on-hand by variation collapses all beers.

**⚠️ SHIP MISHAP (2026-07-22):** PR #236 auto-merged with ONLY the first commit (de646c0, the union-in-code `genericKegOptions`/`kegsForRecipe` approach, variation-only on-hand). The rework commit (f8044e8) was pushed to the branch AFTER the merge → stranded, never reached main. So prod shipped the BUGGY first approach = "8 on hand on every tap." Lesson: after pushing a follow-up commit, CONFIRM the PR isn't already merged before assuming it's included. Fix re-shipped as **PR #239** (branch claude/draft-swap-keg-onhand-fix, off current main): reverts first approach + recipe-keyed on-hand + migration file + recipe-route default. Backfill migration 20260812 was APPLIED to prod by user (69/69 generic-keg links live); #239 carries only code (DB already correct).

Verified `npm run verify` (1810 green); browser E2E blocked by brewer-login (no app creds). Related: [[project_draft_restock_phantom_export]], [[project_unified_draft_pour_consumption]], [[project_ghost_duplicate_packaging_variation_links]].
