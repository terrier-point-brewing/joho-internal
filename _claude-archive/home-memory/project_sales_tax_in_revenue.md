---
name: project-sales-tax-in-revenue
description: Sales tax recognized as P&L revenue — FIXED on PR #286 (open); migrations 20260825/20260826 PENDING plus a human-gated backfill
metadata:
  node_type: memory
  type: project
  originSessionId: f640f4d2-56fe-4eae-ab9c-970d17ef332f
  modified: 2026-07-28T21:00:05.266Z
---

**PR #286 OPEN** (2026-07-28, branch `claude/keen-wing-2566b1`, 22 commits, 36 files).
Found 2026-07-28 while double-checking a cash-flow claim on the tips branch; specced,
planned, and implemented in one session.

`pos_line_items.net_sales_cents` was set from Square's line `total_money`, which is
gross − discount **+ tax**. Overstatement: May $690.32, Jun $1,118.87, Jul $1,078.13 —
**$2,887.32 of $39,525.31 recognized, a flat 7.3%.** Two Square taxes:
`ADD7EKQD2KN72NOYVUWHU34J` General Sales Tax 7.25% (NC DOR) and
`ARI25PLSGLDVIBUQITKTRNSX` Prepared Food & Beverage 1% (Wake County).

Resolution: write side becomes `gross − discount`; collected tax is derived on read in
balance-sheet mode only and credited per authority via a user-editable
`square_tax_id → chart_of_accounts_id` map (new Settings → Sales Tax Accounts tab).
`taproom-model.ts` was already tax-free and is the canonical revenue basis — Financials
now agrees with it.

## ⚠️ Human-gated, still outstanding

- **Migrations 20260825 (`square_tax_accounts`) + 20260826 (`invoice_line_item_taxes`)
  PENDING.** The Settings tab is live in the nav on deploy and **500s until 20260825 is
  applied** — deliberate; a silently-empty account map is worse than a loud failure. The
  Financials reads DO degrade safely.
- **Backfill dry-run by default** at `POST /api/finance/backfill/sales-tax`, never run by
  an agent. Dry run must report exactly
  `{"2026-05": 69032, "2026-06": 111887, "2026-07": 107813}` with
  `skippedIdentityMismatch: 0` and `invoicesSkipped: []`. It issues ~4,740 per-row UPDATEs
  against `maxDuration = 300`; a timeout is expected, every step is idempotent, so re-run.
- Create a Wake County CoA row in the UI (PF&B seeds to `Out Of Scope Agency Payable`),
  then recode the 2026-06-17 −$118.83 Wake remittance, which sits on NC DOR Payable.
- The liability opens with a **debit balance**: June's $1,415.33 of remittances predate the
  POS data and need an opening-balance entry.

## Durable gotchas this uncovered

- **Line-level `total_money` is tax-INCLUSIVE on POS *and* invoice orders** (verified in
  `square_orders.raw_data`: CO2 Refill 10000 − 724 + 673 = 9949). Net sales is
  `gross_sales_money − total_discount_money`, never `total_money`.
- ⚠️ **Two writers populated `invoice_line_items` with different `sort_order` bases** —
  the order path 1-based, canonical `buildInvoiceLineItemRows` 0-based and excise-skipping
  — while `persistInvoiceLineItems` upserts on `(invoice_id, sort_order)`. Any column
  absent from `CanonicalLineItemRow` was never overwritten, corrupting
  `square_line_item_uid` on **60 of 64** populated rows. The daily `finance-sync` cron runs
  BOTH writers in one request, so it recurred daily and would have re-corrupted the new tax
  rows after every backfill. Resolution: the canonical writer now owns the invoice's line
  items AND their tax rows. Caught only by the final whole-branch review — see
  [[feedback_final_review_catches_real_bugs]].
- **Rebase a shared computation onto columns the backfill does not touch.** `squareTaxBase`
  moved from `net_sales_cents − tax_cents` to `gross_sales_cents − discount_cents` —
  identical before AND after the backfill, making deploy/backfill ordering irrelevant
  instead of a hazard. Generalizable trick.
- **A fixture that doesn't match prod can hide the bug entirely.** The shared `order`
  fixture in `syncPosTransactions.test.ts` was tax-EXCLUSIVE, so `net_sales_cents: 1350`
  passed under both the buggy and the fixed code. Correct the fixture first, watch it fail,
  then fix. See [[feedback_frozen_tests_as_equivalence_gate]].
- **Equivalence-gate shape** when fixtures lack the new columns: freeze every `expect(...)`
  VALUE, extend only the fixtures. Three test files, zero expected values changed. Party
  calc tests carry their own duplicate stubs — grep for them, they're easy to miss.
- Invoice-collected tax ($201.26) was invisible to `fetchTaxableBase`, so NC DOR worksheets
  were **understating collected sales tax**. Fixed via the `invoice_line_item_taxes` mirror.
- Refund contra-revenue stays tax-inclusive while revenue is now tax-free — ~$128.41 across
  8 refunds ($1,899.58). Not fixable in code: `square_refunds` has no tax breakdown.
- `square_tax_accounts` is NOT registered in `coa_reference_count()` (migration 20260802,
  another unmerged branch).
- Barrel Excise Tax invoice lines carry an **empty `applied_taxes`** array, so excise and
  sales tax cannot double-count.

**Lesson:** when a column is named `net_sales_cents`, verify what it actually contains
before trusting it. `total_money` in Square is not net sales.

Spec: `docs/superpowers/specs/2026-07-28-sales-tax-liability-passthrough-design.md`
Plan: `docs/superpowers/plans/2026-07-28-sales-tax-liability-passthrough.md`

Related: [[project_tips_balance_sheet_passthrough]], [[project_wake_county_food_beverage_tax]],
[[project_tax_rates_and_registrations]], [[project_invoice_line_item_sort_order_contiguity]].
