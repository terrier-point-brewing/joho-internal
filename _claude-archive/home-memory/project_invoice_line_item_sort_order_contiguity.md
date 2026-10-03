---
name: project_invoice_line_item_sort_order_contiguity
description: "invoice_line_items sort_order MUST be contiguous — persistInvoiceLineItems' trailing-row cleanup deletes rows past rows.length-1, so any gap eats a real line."
metadata: 
  node_type: memory
  type: project
  originSessionId: 23602918-f069-408a-93d0-0ffa6ede5346
  modified: 2026-07-28T01:15:20.175Z
---

`persistInvoiceLineItems` (`lib/finance/invoiceLineItems.ts`) cleans up trailing rows with
`.delete().eq("invoice_id", id).gt("sort_order", rows.length - 1)`. That makes **contiguous
`sort_order` a hard invariant**: any gap means the cleanup deletes a row the same call just
upserted, and a legitimate invoice line silently disappears.

`buildInvoiceLineItemRows` skips carve-out excise lines mid-loop (name contains "barrel excise
tax" + gross matches a discount named "carve out"). It originally numbered from the `forEach`
index, so a middle carve-out produced `[0, 1, 3]` → cleanup deleted the row at 3. Fixed 2026-07-27
in PR #279 by numbering from push position.

**How to apply:** if you ever add another `return`/`continue` that skips a line item in this
mapper, it must not create a `sort_order` gap. Also keep `existingCoaBySort` keyed the same way as
`sort_order` — its keys are DB `sort_order` values this function wrote, so a mismatch shifts a
saved COA onto the wrong line. Latent-only as of the fix: 0/45 prod invoices had gaps and nothing
in the codebase creates a "carve out" discount (hand-added in the Square dashboard only), so no
migration or backfill was needed.

Related: [[project_invoice_line_item_unification]], [[project_invoice_line_item_description_vs_note]].
