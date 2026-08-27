---
name: project-invoice-line-item-description-vs-note
description: "invoice_line_items.description is the catalog label, NOT the Square note — the real note lives in invoice_line_items.note"
metadata: 
  node_type: memory
  type: project
  originSessionId: 60f5ec58-ed8a-4538-9960-eb78d998336b
  modified: 2026-07-28T02:31:12.281Z
---

`invoice_line_items` stores two different strings and they are easy to confuse:

- `description` = `line_item_name + " — " + variation_name` (the Square **catalog** label,
  e.g. `"Packaging Fee — 1/6 Keg"`). Written by `buildInvoiceLineItemRows` in
  `lib/finance/invoiceLineItems.ts`.
- `note` = the free-text note actually attached to the line on the physical Square
  invoice (e.g. `"Packaging Fee — Epic Hazy IPA"`, `"Excise Tax — TTB (25.99 bbls)"`).

Direction of travel: the export-invoice generator sends its composed description as
Square's line-item `note` (`lib/square/square-invoices.ts` — catalog lines take their
name from the catalog, so `note` is the only free-text slot). The read-back / sync then
splits it: catalog label → `description`, Square note → `note`. So the generator's
composed text lands in `note`, never in `description`.

**Why:** 2026-07-27 bug — the Export Invoices tab rendered `description` under a
"Note:" label, so every packaging-fee line read `"Packaging Fee — 1/6 Keg"` instead of
`"Packaging Fee — Epic Hazy IPA"`. Same trap for anything else reading these rows.

**How to apply:** when displaying "the note", read `note`, and fall back to
`description` ONLY when `line_item_name` is null. Catalog identity is the tell: rows
with `line_item_name` are Square-synced, so a null `note` there means the line truly
has no note (55 such rows in prod as of 2026-07-27) and a blanket
`note ?? description` fallback echoes the item label back as a bogus note. Rows
without catalog identity come from the non-Square fallback inserts, where
`description` IS the note. Don't dedupe by string compare — the catalog label joins
with `·` and `description` with `—`, so they never match. When writing a line to
Square, send the **note** text as the draft's
`description` field — sending the stored `description` replaces every real note with
the catalog label. Fixed in the export line-items PATCH route, which now re-persists
via `buildInvoiceLineItemRows`/`persistInvoiceLineItems` instead of a hand-rolled
insert (that insert also hardcoded `category: "other_services"`, flattening
`packaging_fees`/`pass_through_taxes`).

Related: [[project_invoice_line_item_unification]],
[[project_invoice_packaging_materials_charge]].

Related latent bug found alongside this and FIXED in PR #279 (merged 2026-07-27):
`buildInvoiceLineItemRows` skipped carve-out excise lines with `return` inside a
`forEach` while numbering `sort_order` from the loop index, so rows developed gaps
(`[0,1,3]`); `persistInvoiceLineItems` then deleted `sort_order > rows.length - 1`,
dropping the row it had just written. Never fired in prod (0 of 45 invoices had
non-contiguous `sort_order`, and nothing in the codebase creates a "carve out"
discount — it must be added by hand in the Square dashboard). See
[[project_invoice_line_item_sort_order_contiguity]].
