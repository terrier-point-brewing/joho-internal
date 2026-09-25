---
name: project-sku-mapping-consolidation
description: Square SKU mapping consolidation — decisions + plan location for the export rework
metadata: 
  node_type: memory
  type: project
  originSessionId: 4decb1f5-c2ff-48a6-9516-bd3718cd66e9
---

Consolidation of the three Square-mapping tables (`recipe_square_links`, `invoice_item_mappings`, `square_catalog_variations`) so taproom/intake/export/finance resolve SKUs through one path. Decided 2026-06-28 (branch `feature/export-rework`). Plan: `docs/superpowers/plans/2026-06-28-square-sku-mapping-consolidation.md` (11 tasks, handed off for subagent-driven implementation in a worktree).

Decisions (user-confirmed):
- **Option B** — keep the two mapping tables physically separate; put ONE resolver module `lib/square/skuMappings.ts` in front (`resolveProductSku`/`resolveServiceSku`/`resolveCatalog`). No feature queries the tables directly.
- **Option A** — inventory-unit semantics (`inventory_unit`, `volume_fl_oz_per_unit`) live ON the catalog mirror `square_catalog_variations`, populated during catalog sync; collapses the duplicated name-parsers (`ozPerSale` in sell-through removed; `canOzPerUnit` in reports left alone — reports are out of scope).
- **Variation-grain product mapping** — `recipe_square_links` re-keyed from `(recipe, container, format)` to `variation_id` (FK → `packaging_variations`) for keg/can; **draft stays recipe-grain** (variation_id null, one per recipe). Fixes the collision where two beer-specific variations sharing container+format (e.g. Epic Hazy "Printed Can" vs "Be Like Mike Labeled Can", both 16oz can — see migration `20260707_beer_specific_packaging_variations.sql`) couldn't both be linked.
- **Fee mapping** `invoice_item_mappings` stays coarse `(service_type, partner_id, container, format)` — packaging fees are beer-agnostic by design (one generic Square Packaging Fee item). Do NOT move it to variation grain.

Key finding: production is the most complete packaging model and keys everything on `packaging_variations.variation_id` (batch_transfers, cold_storage_inventory unique on (batch_id, variation_id), export bay ship flow). The universe needing a product mapping = the rows in `recipe_packaging_variations`. The `RecipeLinkMatrix` tool was rebuilt to variation grain (one row per recipe_packaging_variation, completeness count, bulk "accept all", name-based auto-suggest) since hand-mapping ~51-and-growing variations one-by-one is unworkable.

No test framework existed; plan adds Vitest scoped to `lib/**` pure-logic only (parser, resolver helper, matrix builder). Related: [[project-three-channel-invoicing]].
