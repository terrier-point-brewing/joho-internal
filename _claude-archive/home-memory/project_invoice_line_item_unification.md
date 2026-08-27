---
name: project_invoice_line_item_unification
description: "2026-07-11 export+deposit invoice line items unified onto one canonical shape from Square's authoritative order; PR"
metadata: 
  node_type: memory
  type: project
  originSessionId: d728e573-20f5-4157-aaa1-17725426159b
---

Export + deposit invoice line items now write ONE canonical `invoice_line_items` shape sourced from Square's authoritative order, killing the description drift + a missing-discount/gross-total bug (diagnosed on #000031's absent 30%/$948 bulk discount and #000037's 5 unmapped GL lines).

**Architecture:** shared mapper `lib/finance/invoiceLineItems.ts` (`buildLineItemIndexes`, `buildInvoiceLineItemRows`, `invoiceHeaderTotalsFromOrder`, `persistInvoiceLineItems`, `resolveLineItemCoa`). The year-sync, the webhook `syncSquareInvoiceById`, and the export + deposit `generate` order read-backs all route through it. Auto-map (`lib/finance/autoMap.ts` `resolveInvoiceBackfill`) keys off `square_catalog_variation_id` first, description fallback. Finance invoices tab = 7 columns (`line_item_name — variation_name | note | qty | unit | discount_cents | net_sales_cents | GL`) + invoice-level discount/tax summary rows. Column model: `net_sales_cents` = gross − discount (pre-tax) is the line Total; header `total_cents` = Square `order.total_money`.

**Status (2026-07-11): COMPLETE.**
- PRs #161 (core) + #165 (finalize) MERGED to main.
- Migrations `20260710_invoice_line_item_unification.sql` (adds `line_item_name`, `invoices.discount_cents`, consolidates catalog ref) and `20260711_drop_legacy_line_item_catalog_refs.sql` (drops `invoice_line_items.square_variation_id` + `square_catalog_object_id`) BOTH APPLIED to prod.
- **Backfill DONE:** re-synced all 35 2026 square invoices via `syncSquareInvoiceById` + `autoMapInvoiceLineItems(sb,{year:2026})`. Verified: #031 discount $948/total $2,363.39 correct; #037 all 6 lines GL-mapped; 98/99 lines mapped, 25 discount lines recorded. (To run the sync outside Next: mock the `unstable_cache`-wrapped `fetchCatalogItems` to its uncached form; per-invoice path avoids `readBreweryTimezone` cache; year path needs it mocked too.)
- **#165 fixes:** mapper prefill now `chart_of_accounts_id_invoice ?? chart_of_accounts_id` (one-pass GL mapping, no separate auto-map needed); `syncPosTransactions.buildInvoiceLineItems` migrated onto `square_catalog_variation_id`.
- **Known residual (won't-fix unless asked):** #031's Square order has no per-line notes, so its two excise lines show no col2 differentiator (backfill takes note from Square, which is empty for that old order). New invoices set the note at creation. Optional browser spot-check of the 7-col display never done (DB-verified instead).

Spec: docs/superpowers/specs/2026-07-10-export-invoice-line-item-unification-design.md · Plan: docs/superpowers/plans/2026-07-10-export-invoice-line-item-unification.md. Related: [[project_transactions_automap_trigger]] (#158 auto-map extraction this merged against), [[project_invoice_net_terms]] (#160 net-terms, merged alongside).
