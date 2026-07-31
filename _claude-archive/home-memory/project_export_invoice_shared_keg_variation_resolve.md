---
name: project_export_invoice_shared_keg_variation_resolve
description: "2026-07-23 export invoice \"JSON object requested, multiple (or no) rows returned\" — resolveProductSku packaged keyed on variation_id alone; generic keg sizes are shared across recipes so it must key on (variation_id, recipe_id)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 59003c22-df95-4cf1-9792-fdc91d720336
  modified: 2026-07-24T01:22:10.875Z
---

Generate Invoice in Production → Export → Shipments threw `JSON object requested, multiple (or no) rows returned` for distribution/wholesale **keg** invoices.

**Root cause:** `resolveProductSku(db, {kind:"packaged"})` in [[project_sku_mapping_consolidation]] (`lib/square/skuMappings.ts`) filtered `recipe_square_links` by `variation_id` ALONE, then `.maybeSingle()`. But the generic keg sizes (1/6, 1/4, 1/2 Keg) are **one shared `packaging_variations` row each, linked per-recipe** — 16–17 `recipe_square_links` rows share each keg variation_id, every recipe carrying its own `square_variation_id`. `.maybeSingle()` tolerates 0 rows but throws on ≥2 → the error. Confirmed live: 3 duplicate variation_id groups (the three keg sizes); `(variation_id, recipe_id)` is unique (max 1 row/recipe).

⚠️ Durable schema truth: `recipe_square_links.variation_id` is **NOT globally unique** in prod, despite migration `20260710`'s `rsl_variation_uniq` comment ("one product link per packaging_variation") — that index is not enforced. The real grain is the `20260628` `(variation_id, recipe_id)` unique index.

**Fix (branch `claude/invoice-export-shipments-json-32af68`, PR #250 OPEN):** added required `recipeId` to the packaged arg of `resolveProductSku` and filter `.eq("recipe_id", …)`. Both callers already had recipe in scope: `exportInvoicePreview.ts` (buildProductLines, `tx.recipe_id`) and `reconcileSquareCanInventory.ts` (byRecipe loop `recipeId`, which also had a defensive try/catch for this very throw). No migration, no data fix — the shared-variation data is the correct domain model. `npm run verify` green (1826 tests); added `resolveProductSku` unit tests to `lib/square/skuMappings.test.ts`. Related: [[project_ghost_duplicate_packaging_variation_links]], [[project_draft_swap_keg_generic_options]].
