---
name: project_invoice_packaging_materials_charge
description: "Auto-charge packaging materials on contract-brewing can export invoices (PR #265)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 46835cfd-c6ea-4fd5-a4f0-c22cf7b22db1
  modified: 2026-07-25T14:58:54.109Z
---

2026-07-24: Contract-brewing export invoices with **can** shipments now auto-add a per-recipe **Packaging Materials** line = summed unit cost of components consumed (container/lid/label/paktech/tray). Pure cost pass-through, no markup, no schema change. Consumes the previously-orphaned `packaging_material` service mapping.

- Pure math: `lib/production/packagingMaterials.ts` `computeMaterialCost` (per-format qty math mirrors `packagingVariations.ts` getUnitsPerPackage/getPaktechUnitsPerPackage but runs on already-fetched `can_count`s — no extra queries). Costs from `packaging_items.unit_cost` (USD decimal, nullable) → cents via `dollarsToCents`.
- Wiring: `buildPackagingMaterialLines` in `exportInvoicePreview.ts`, called in the `contract_brewing` branch after Forklift. **Resolves the LITERAL shipped variation via `export_transactions.variant_label`** (text, = variation.name at ship time, written by writeExportTransaction `shipmentWriter.ts:125`) matched against `packaging_variations.name` scoped to recipe. export_transactions has NO variation_id. ⚠️ `(recipe ∩ container ∩ format)` is AMBIGUOUS — one liquid ships under two brand labels sharing a can+format (prod: "Pumpkin Ale" links to BOTH Fortnight Pumpkin Ale AND CBC Pumpkin Reaper cases of the same 16oz Blank). Must key on variant_label to pick the right label + its cost. (First attempt used container+format+cost-dedup — got the $ right by luck since both labels were null-cost; user corrected it.) `packaging_material` catalog mapping is OPTIONAL (findMapping("packaging_material", null)) — supplies Square catalog/GL identity only; price is always computed (null id → ad-hoc line, like the excise line).
- Cans only (kegs skipped). Automatic for every contract-brewing can invoice, NO per-partner toggle (delete the line in the modal to opt out).
- Warn-don't-block: null unit_cost → billed $0 + named in new `InvoicePreviewResult.warnings[]`; unresolvable variation → skipped + warned (never throws, so a materials line can't block an otherwise-valid invoice). Modal renders `warnings` as `<Banner tone="accent">`.

**PR #265 MERGED (be7b1df) + PR #267 MERGED (98e79f8); worktree + branches cleaned 2026-07-25.** #265 squash-merged at an EARLY snapshot (container+format version); the variant_label fix got STRANDED (same squash-merge hazard as [[project_brand_design_system]]) → re-landed as #267. Both content now on main (variant_label resolution live). ⚠️ `buildProductLines` (distribution/wholesale) had the SAME ambiguous container+format resolution with a hard THROW → fixed by follow-up **PR #268** (see [[project_export_product_lines_variant_label_resolve]]). No migration. ⚠️ Browser E2E NOT run — local `/production` is auth-gated. ℹ️ Materials charge does NOT require a Square catalog link (packaging_material mapping optional, price computed); the "Check Link Styles to Square" advisory wording is misleading (refers to internal recipe↔variation link) — reword candidate, still unaddressed. Related: [[project_shipment_channel_billing_exceptions]] (billAs override → materials keys on effective/billed channel), [[project_export_invoice_shared_keg_variation_resolve]] (variation resolution can be non-unique).
