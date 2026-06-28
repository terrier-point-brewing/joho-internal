# Export UI Redesign — Spec

**Date:** 2026-06-27  
**Status:** Approved, ready for implementation

## Overview

Redesign the Export section of Production to:
1. Unify all shipment channels into a single "Shipments" tab with proper filtering/sorting
2. Introduce an "Export Invoices" tab as an invoice-centric view with expandable detail rows
3. Remove the redundant "Taproom" top-level tab; move the Square catalog link manager into Export Settings
4. Replace `export_transactions.square_invoice_id` with `invoice_id FK → invoices.id` for clean relational linking

---

## Tab Structure

**Before:**
```
Export Bay | Taproom | Export Transactions
```

**After:**
```
Export Bay | Shipments | Export Invoices
```

The "Taproom" top-level tab is removed. The `SquareLinkManager` trigger button (previously in the Taproom tab) moves to `ExportSettingsPanel`. The `SquareLinkManager` component itself is unchanged — it is shared across production/taproom sections.

---

## DB Migration

### Replace `export_transactions.square_invoice_id` with `invoice_id`

**Rationale:** All invoices (Square-generated, manually recorded, QB mark-paid) are stored in the `invoices` table. The current `square_invoice_id` varchar on `export_transactions` is a denormalized copy of `invoices.square_invoice_id`. Replacing it with a proper FK eliminates the ambiguity and enables clean relational queries for both Square and non-Square invoices.

**Migration steps:**
1. Add `invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL` to `export_transactions`
2. Backfill: `UPDATE export_transactions et SET invoice_id = inv.id FROM invoices inv WHERE et.square_invoice_id = inv.square_invoice_id`
3. Drop `export_transactions.square_invoice_id`

**API route changes required:**
- `/api/production/exports` GET: join `invoices` via `invoice_id` instead of joining on `square_invoice_id`
- `/api/production/export/invoice` POST:
  - `generate` action: after creating the Square invoice, immediately upsert a draft `invoices` row and set `export_transactions.invoice_id`
  - `record` action: already creates `invoices` row — set `invoice_id` on transactions
  - `mark_paid` action: already creates `invoices` row — set `invoice_id` on transactions
  - `send` action: look up `invoices` row via `export_transactions.invoice_id` to find `square_invoice_id` for Square API call
  - `sync` action: same
- `/api/production/export/invoice-status` GET: look up Square ID via `invoices` join

---

## Shipments Tab

### Purpose
Show all export shipments across all four channels (taproom, distribution, contract_brewing, wholesale) in a single chronological list. Invoiceable channels support multi-row selection for invoice generation.

### Layout

**Filter bar (top):**
- Channel: `All | Taproom | Distribution | Contract | Wholesale` (pills or dropdown)
- Status: `All | Invoice Required | Unpaid | Paid`
- Customer: dropdown of partners
- Date range: from/to pickers

**Table** (sortable by any column, default sort: date descending):
| — | Date | Channel | Customer | Batch | Packaging | Qty | Status | Invoice # |
|---|------|---------|----------|-------|-----------|-----|--------|-----------|

**Row behaviors by channel/status:**
- **Taproom rows**: no checkbox; `—` in Invoice # and Customer columns; non-selectable; shows a "Taproom" channel badge
- **Invoiceable + `invoice_required`**: checkbox available for selection
- **Invoiceable + `unpaid`**: no checkbox; Invoice # column shows invoice number as a clickable badge that navigates to Export Invoices tab (filtered/scrolled to that invoice); status badge "Unpaid"
- **Invoiceable + `paid`**: same as unpaid but "Paid" badge (success styling)

**Selection-lock behavior:**
- First checked row establishes a customer-lock. Only rows with the same `recipient_id` remain checkable; all others show a muted disabled state until selection is cleared.
- Taproom rows are always non-checkable regardless of selection state.

**Sticky action bar (appears at bottom of viewport when rows are selected):**
```
N rows selected — [Customer Name]   [Generate Invoice]  [Mark Paid]  [Clear]
```
- "Generate Invoice" opens the existing `InvoicePreviewModal` (unchanged) with the selected transaction IDs
- "Mark Paid" opens the existing mark-paid modal (unchanged)
- After successful invoice creation, action bar clears and the new invoice row appears in Export Invoices

**Invoice management actions (Send/Sync):**
Removed from Shipments. These live in the Export Invoices tab. Shipments is read-only after an invoice exists.

---

## Export Invoices Tab

### Purpose
Invoice-centric view. See all created export invoices with full detail. Manage Draft invoices (add line items, send). Track status of sent invoices (sync from Square).

### Data Source
New API route: `GET /api/production/export/invoices`

Queries:
- `invoices` WHERE `partner_id IS NOT NULL AND invoice_type = 'standard'`
- Joins: `invoice_line_items`, `export_transactions` (via `invoice_id` FK), `contract_brewing_partners`

### Layout

**Filter bar:**
- Customer: dropdown
- Status: All | Draft | Sent/Open | Paid | Voided
- Year: year picker

**Summary strip:**
```
N invoices  |  $X open  |  $Y total
```

**Expandable row table (batch-log style — click row to toggle expand):**

Collapsed columns:
| ▸ | Invoice # | Date | Customer | Status | Total |
|---|-----------|------|----------|--------|-------|

Expanded panel (below row, in-place):

```
┌─ Invoice Metadata ──────────────────────────────────────────┐
│  Customer:  [partner name]                                  │
│  Issued:    [invoice_date]    Channel: [derived from txns]  │
│  Status:    [status badge]    Source: [Square / QuickBooks] │
│  Square ID: [link → View in Square]  (if source=square)    │
│  [View in Finance →]  (links to Finance > Invoices page)   │
└─────────────────────────────────────────────────────────────┘
┌─ Included Shipments ────────────────────────────────────────┐
│  Date | Batch | Channel | Packaging | Qty | Volume          │
│  (from export_transactions WHERE invoice_id = this.id)      │
└─────────────────────────────────────────────────────────────┘
┌─ Line Items ────────────────────────────────────────────────┐
│  Description | Qty | Unit Price | Total                     │
│  ...                                                        │
│  ──────────────────────────────────── Total: $X.XX         │
│                                                             │
│  [Draft only] + Add line item ─────────────────────────────│
│    Pick from: [service mapping ▾]  or  [custom]             │
│    Description: [      ]  Qty: [  ]  Unit price: [      ]  │
│    [Add]                                                    │
└─────────────────────────────────────────────────────────────┘
┌─ Actions ───────────────────────────────────────────────────┐
│  [Send Invoice]          (visible only when status=Draft)   │
│  [Sync from Square]      (visible when source=square, !paid)│
└─────────────────────────────────────────────────────────────┘
```

### Draft Line Item Editing

For **Draft** invoices only:
- Line items table shows existing items with remove (×) buttons
- "Add line item" section below: user picks from service mappings (loaded from `/api/production/export-settings/service-mappings`) or enters a custom description + qty + unit price
- Adding/removing a line item calls a new API action: `PATCH /api/production/export/invoices/:id/line-items`
  - Calls Square API to update the draft invoice
  - Updates `invoice_line_items` table
- Once sent, line items section is read-only (Square locks sent invoices)

Line items auto-populated at generation time by `buildInvoicePreview` (unchanged) — the Export Invoices tab editing is complementary for post-generation adjustments.

### "View in Finance →" link

Links to Finance > Invoices page. The Finance tab handles GL account mapping and double-entry bookkeeping detail that this tab does not replicate. The Export Invoices tab is operational (what shipped, what was invoiced, what was paid); Finance is financial (GL classification, QB reconciliation).

---

## Export Settings Panel Changes

Add a new "Square Catalog Mappings" section to `ExportSettingsPanel` containing:
- The existing `SquareLinkManager` trigger button (previously in the Taproom sub-tab of ExportTab)
- Label: "Recipe → Square Catalog Links" with the existing description ("Links recipes to Square catalog items for inventory sync on taproom exports")
- Same `SquareLinkManager` component/modal, just triggered from here instead

---

## Files Affected

**DB migration (new file):**
- `supabase/migrations/20260708_export_invoice_fk.sql`

**API routes (modified):**
- `app/api/production/exports/route.ts` — update join to use `invoice_id`
- `app/api/production/export/invoice/route.ts` — update all actions to set `invoice_id` FK; `generate` must now upsert draft `invoices` row immediately

**API routes (new):**
- `app/api/production/export/invoices/route.ts` — GET export invoices list with joins
- `app/api/production/export/invoices/[id]/line-items/route.ts` — PATCH to add/remove line items on Draft invoices

**Components (modified):**
- `app/production/components/ExportTab.tsx` — update tab list (remove Taproom, add Export Invoices), remove `ExportsChannelTab` component and Taproom rendering
- `app/production/components/ExportSettingsPanel.tsx` — add Square link manager section
- `app/production/components/ExportTransactionsTab.tsx` — full redesign → becomes `ShipmentsTab.tsx`

**Components (new):**
- `app/production/components/ShipmentsTab.tsx` — flat list, selection-lock, sticky action bar
- `app/production/components/ExportInvoicesTab.tsx` — expandable invoice rows with metadata/shipments/line items/actions

**Components (unchanged):**
- `app/production/components/InvoicePreviewModal.tsx`
- `app/production/components/SquareLinkManager.tsx`
- `app/finance/invoices/page.tsx`

---

## Finance > Invoices Overlap

The Finance > Invoices page (`app/finance/invoices/page.tsx`) remains unchanged. It continues to serve its purpose: GL account mapping, invoice type classification, batch linking, and QB reconciliation. Export invoices appear there too (they share the same `invoices` table), filtered by the existing type/source filters.

The Export Invoices tab is the operational surface (who got what, what was charged). Finance Invoices is the accounting surface (how is this classified, is it reconciled). Different audiences, different detail level, same underlying data.

---

## Out of Scope

- No changes to `InvoicePreviewModal` (works as-is for invoice generation)
- No changes to the Mark Paid modal
- No changes to `ExportBayTab`
- No GL mapping in the Export Invoices tab (Finance tab handles that)
- No pagination (existing pattern; will add if list grows large)
