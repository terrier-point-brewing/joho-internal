---
name: project_export_product_lines_variant_label_resolve
description: "2026-07-24 buildProductLines resolves export distro/wholesale product lines by variant_label, fixing the two-brand-label ambiguity throw"
metadata: 
  node_type: memory
  type: project
  originSessionId: 0cd3860f-ca71-4356-b379-19cfcd1b8aa7
  modified: 2026-07-25T15:22:06.161Z
---

`lib/production/exportInvoicePreview.ts` `buildProductLines` (distribution/wholesale invoice product lines) resolved each export tx's packaging variation by `(recipe_id ∩ packaging_variations.container_id ∩ format)` and THREW "N candidates" when >1 matched. Latent bug: one recipe can ship one liquid under TWO brand labels sharing the same container+format → triple matches 2+ variations → whole invoice blocked. Confirmed prod: recipe "Pumpkin Ale" (b075096b-0009-4e64-8741-3a7957921e03) links BOTH "Fortnight Pumpkin Ale - 16oz Labeled Can Case" AND "CBC Pumpkin Reaper Ale - 16oz Labeled Can Case" of the same 16oz blank can (8921dfe9-c8e5-404a-bdfc-ddae4888fca1).

Fix: resolve by the LITERAL variation shipped — `export_transactions.variant_label` (= `packaging_variations.name` at ship time, written by writeExportTransaction) — via `recipe_packaging_variations.eq(recipe_id).eq("packaging_variations.name", variant_label)`. Resolved `variation_id` flows unchanged into `resolveProductSku({kind:"packaged",variationId,recipeId})`. Same approach as the packaging-materials path in [[project_invoice_packaging_materials_charge]] (#265).

Behavior: FAIL-CLOSED kept (user-confirmed) — unresolvable variant_label AND missing Square product link both throw, since a product line IS the invoice and degrading would undercharge. This differs from `buildPackagingMaterialLines`, which degrades to a non-blocking warning.

Tests: exported `buildProductLines`; added `productStub` (dispatches pv-resolve thenable + SKU `.maybeSingle()` by chained filters) + 4 cases. Verify green (1904 tests). **PR #268 MERGED 2026-07-25 (squash 22b596a); worktree removed + branch deleted.** No migration.
