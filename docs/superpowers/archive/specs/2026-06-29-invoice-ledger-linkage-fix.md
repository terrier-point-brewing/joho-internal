# Invoice Ledger Linkage Fix

**Date:** 2026-06-29  
**Scope:** Fix export invoice routing into the `invoices` ledger — wrong type, broken source, missing batch links, wrong line item category.

---

## Problem Summary

Four bugs exist in how production-side invoice routes write into the `invoices` table:

1. **Wrong `invoice_type`**: All export invoice paths write `invoice_type: "standard"`, making them indistinguishable from QB-imported standard invoices.
2. **Broken `'other'` source**: `record` and `mark_paid` actions have a literal bug (`const dbSource = source === "quickbooks" ? "quickbooks" : "quickbooks"`) that always writes `'quickbooks'`. Migration `20260705` already added `'other'` to the DB constraint.
3. **No `invoice_batch_links` for export invoices**: Deposit invoices create batch links on generation; export invoices create none. The "Batches" column in the finance invoices page always shows `—` for export invoices.
4. **Wrong line item categories**: Deposit line items use `category: "other_services"`. Additionally, `classify.ts` conflates ingredient deposits and packaging materials under `materials_packaging` — these map to different GL accounts and must be separate categories.

---

## Design

### New type and category values

**`InvoiceType`** gains `"export_invoice"`:
- `standard` — QB-imported or manually recorded non-export invoices
- `allocation_deposit` — deposit invoices for batch allocations
- `export_invoice` — invoices generated from export shipments

**`InvoiceLineCategory`** gains `"ingredient_deposit"`:
- `ingredient_deposit` — ingredient cost deposit (charged on deposit invoices)
- `materials_packaging` — packaging materials, e.g. cans, labels (charged on export invoices)
- `packaging_fees` — packaging labor/service fee
- `other_services` — keg cleaning, forklift, CO2 refill, etc.
- `pass_through_taxes` — barrel excise tax
- `distribution_keg` / `distribution_can` — matched against Square catalog
- `other` — fallback

### Category routing in `classify.ts`

```
"ingredient deposit" → ingredient_deposit   (was: materials_packaging)
"packaging material" → materials_packaging  (unchanged)
```

### Route fixes

**`/api/production/export/invoice` (all 3 write paths)**:
- Add `batch_id` to initial `export_transactions` select
- `generate`: `invoice_type: "export_invoice"`, create `invoice_batch_links` for distinct batch IDs post-creation
- `record`: fix `dbSource` (pass `source` directly), `invoice_type: "export_invoice"`, create batch links
- `mark_paid`: fix hardcoded `"quickbooks"` (use `source`), `invoice_type: "export_invoice"`, create batch links

**`/api/production/export/invoices` (GET list)**:
- Change filter: `.eq("invoice_type", "export_invoice")`

**`/api/production/allocations/[id]/invoice` (deposit)**:
- `upsertFinanceLedgerInvoice`: line item `category: "ingredient_deposit"` (was `"other_services"`)
- `mark_paid`: fix hardcoded `source: "quickbooks"` — use `source` from request body

### Type and UI updates

- `types/finance.ts`: add `"export_invoice"` to `InvoiceType`, add `"ingredient_deposit"` to `InvoiceLineCategory`
- `app/finance/invoices/page.tsx`: add `"export_invoice"` option to type filter

### Migration (single file)

1. Extend `invoice_type` check to include `'export_invoice'`
2. Extend `invoice_line_items.category` check to include `'ingredient_deposit'`
3. Backfill: `invoice_type = 'export_invoice'` for rows linked via `export_transactions.invoice_id`
4. Backfill: create missing `invoice_batch_links` from `export_transactions` (distinct batch_id per invoice_id)
5. Backfill: `source = 'other'` for rows where `external_id LIKE 'other:%'` (wrongly stored as `'quickbooks'`)
6. Backfill: `category = 'ingredient_deposit'` for line items where `description = 'Ingredient Deposit'`

---

## Files Changed

| File | Change |
|---|---|
| `supabase/migrations/20260629_invoice_ledger_linkage_fix.sql` | New migration |
| `types/finance.ts` | Add `"export_invoice"`, `"ingredient_deposit"` |
| `lib/finance/classify.ts` | Route "ingredient deposit" → `ingredient_deposit` |
| `app/api/production/export/invoice/route.ts` | Fix type, source, add batch links |
| `app/api/production/export/invoices/route.ts` | Fix type filter |
| `app/api/production/allocations/[id]/invoice/route.ts` | Fix category, fix source |
| `app/finance/invoices/page.tsx` | Add export_invoice filter option |
