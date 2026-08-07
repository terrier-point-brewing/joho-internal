---
name: project_deposit_recognition_retirement
description: 2026-07-17 Contract-brewing deposit revenue was stranded off the P&L; retired the deferred-revenue model → immediate recognition
metadata: 
  node_type: memory
  type: project
  originSessionId: b524fd7a-4573-4efc-a572-d8c4166aa2a5
---

**2026-07-17.** Contract-brewing "Ingredient Deposit" revenue (GL **4320** Pass-Through Raw Materials, id `4b2ba43e-8021-484f-add2-339112478a7f`) was permanently missing from the Financials P&L. Root cause: deposit lines carried a dual mapping (`bs_chart_of_accounts_id` deferral liability + `pl_chart_of_accounts_id`=4320), and `resolveInvoiceCoaId` (aggregateRows.ts) only used the PL account once a linked delivery invoice was `paid`. But `delivery_invoice_id` + `account_mode` were **never populated on a single row** (confirmed in prod), and delivery/export invoices bill disjoint accounts (4310/4330/4340 — never 4320 materials), so the recognition trigger never fired → deposits stuck on the balance sheet forever.

**Decision (user):** recognize deposits **immediately** (accrual, on invoice date) + retire the delivery-link/dual-mapping concept entirely. Zero double-count risk since deposit & delivery invoices bill disjoint GL accounts.

**Also fixed:** Square status `PAYMENT_PENDING` (ACH in-flight) wasn't in `mapSquareInvoiceStatus` → app-created July deposits showed status `unknown`. Added `PAYMENT_PENDING → open` (invoiceStatus.ts). Affects any ACH-paid invoice.

**Shipped on branch `claude/income-statement-uncleared-filter-67f8eb` (verify GREEN, 1608 tests). NOT committed/merged yet.**
- Resolver = `pl_chart_of_accounts_id ?? chart_of_accounts_id` (immediate). Removed `deliveryInvoicePaid`/`force_bs`/`force_pl`/`bs` from InvoiceLineRecord + fetchInvoiceLines + parity script.
- Retired ingest of bs/pl (invoiceLineItems.ts, syncSquareInvoices.ts) — new deposits map to 4320 via `chart_of_accounts_id` directly (deposit variation `3GLK4RMQGF6QBM2I46BC3DQQ` base chart = 4320).
- Removed bs/pl/delivery/account_mode UI in settings/account-mapping + transactions/invoices pages + ledger routes; removed the "Stranded Deposits" data-quality card.
- Staged migration `20260802_retire_deposit_recognition_columns.sql` drops dead cols (`invoice_line_items.{bs_chart_of_accounts_id,delivery_invoice_id,account_mode}` + `square_catalog_variations.{bs,pl}`). **KEEPS `invoice_line_items.pl_chart_of_accounts_id`** (still load-bearing for pre-backfill July rows).

**Dollar impact (verified vs prod, code-change alone, no data migration):** June $2,570.30 + July $6,582.29 = **$9,152.59** now on the P&L (these have pl=4320).

**PENDING (human-gated prod work):**
1. **Backfill** (SHOWN to user, awaiting run + backup): `UPDATE invoice_line_items SET chart_of_accounts_id = 4320 for non-voided allocation_deposit lines`. Recovers a **May straggler $1,665.83** (invoice `609989ba`, line `710b3ed9`, mapped to BS acct 2430, pl=NULL — resolver can't rescue it). Also normalizes chart→4320 so pl becomes fully redundant.
2. Apply migration `20260802` (drop dead cols) after backfill + backup.
3. **Phase 3 follow-up (after backfill):** switch resolver to `chart_of_accounts_id` alone, drop `pl` reads (fetchSources + parity script), drop `invoice_line_items.pl_chart_of_accounts_id`.

Learning: [[feedback_subagent_git_stash_hazard]] — a parallel subagent's `git stash` wiped the shared worktree mid-task; recovered via `git stash apply`.
