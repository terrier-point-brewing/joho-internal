---
name: project_canceled_orders_voided_line_items
description: 2026-07-19 — canceled orders in the Orders ledger now show read-only voided line items reconstructed from raw_data; PR
metadata: 
  node_type: memory
  type: project
  originSessionId: ca63d902-be0e-4fe1-871f-03986c31e7f6
---

Canceled Square POS orders showed a header total + tax but "No line items" in Finance > Transactions > Orders (and breakdown read Gross $0 / Tax $0.58). **Root cause is by-design, not a bug:** `syncPosTransactions.ts` `classifyOrderForSync` returns `"cancel"` for CANCELED orders → keeps the `square_orders` header row (total_cents/tax_cents preserved as audit trail) but **deletes all `pos_line_items` and re-inserts none**.

**Why line items are stripped (load-bearing invariant):** the P&L feed [[project_financials_consolidation]] `lib/finance/financials/fetchSources.ts` AND the sales-tax base `lib/tax/squareTaxBase.ts` both join `pos_line_items` → `square_orders` with **NO status filter** — they rely on "canceled ⇒ zero line items" so voided sales contribute $0. `autoMap.ts` also fetches all square_orders (no status filter). Never naively re-populate pos_line_items for canceled orders — it silently leaks voided sales into revenue + taxable base.

**Fix (PR #229, MERGED 2026-07-19, squash b2fc9d3):** display-only reconstruction from `square_orders.raw_data` (the full Square Order JSON, incl. line_items/taxes/discounts, is stored there by `buildOrderPayload`). New `lib/finance/voidedLineItems.ts` (`extractVoidedLineItems`, `voidedGrossSalesCents`, pure + test). Transactions API attaches `voided_line_items` via a targeted 2nd query for canceled orders with empty pos_line_items. Orders ledger renders a read-only `VoidedLineItemRow` (struck-through, "voided — excluded from financials", no GL dropdown); breakdown Gross now sources from voided items. **No pos_line_items rows created → invariant preserved by construction.** Worktree/branch cleaned.

The 3 example orders were real voided taproom bar tabs from 2026-07-17 (Archer Roose wine, Untitled Art seltzer, FLVR NA IPA), each a single beverage with a $15 CARD tender status VOIDED (auth never captured).

⚠️ Browser E2E NOT verified — app login wall, no credentials in this env (recurring limitation, see other notes).
