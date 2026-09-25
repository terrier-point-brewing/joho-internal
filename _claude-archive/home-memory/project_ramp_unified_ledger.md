---
name: project_ramp_unified_ledger
description: "2026-07-08 — Ramp bills + bank-account ledger ingest into unified transactions basis for statements; spike done, findings in docs/ramp-ledger-ingest.md"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9f98ea1a-5d3f-475c-9b48-8e6170a795b0
---

Branch `claude/ramp-bills-expenses-sync`. Goal: make finance → Transactions tab the single drift-free basis for all statements (statements rework is the NEXT project, on this cleaned data). Today only Ramp card transactions ingest into `expenses`; adding **bills** and **operating bank-account lines**.

**Spike complete** (`scripts/ramp-api-spike.mjs`, read-only, Node 22 `--env-file`). Full findings + design in `docs/ramp-ledger-ingest.md`. Key facts:
- Ramp app **already grants** all read scopes (bills:read, banking:read, transfers:read, accounting:read) — only code change is extending `RAMP_SCOPES` in `lib/ramp.ts`. No dashboard change to read.
- Bills code to GL per `line_items[].accounting_field_selections` (same GL_ACCOUNT shape as txns) → existing auto-map works.
- **Latent bug:** `extractGlAccount` reads `external_id` as the account code; QuickBooks account NUMBER is actually in `external_code` (e.g. "5230"). Number-match in `matchAccountToCoa` never fires; falls back to name-match. Fix: prefer `external_code`.
- Bank ledger = `/banking/syncable-transactions`, **uncoded**. Classify by `description` (Withdrawal/Deposit/Interest/Vendor Payment) + counterparty (`GUSTO`, `ERIE`, own accounts). `treasury_transfer_type` is useless (always WALLET_TRANSFER).
- **Drift hazard:** `Vendor Payment` bank lines settle already-booked bills; card autopay settles already-booked txns → double count. Rule: settlements excluded from P&L; only direct external debits (Gusto/Erie, no bill/card behind) become expenses.

**Decisions locked by user:**
- Two tables: `expenses` = card + bill + true operating-expense bank debits; NEW table = other bank lines (interest income, transfers, settlements, deposits) carrying `flow_type` + `affects_pl`.
- Sign convention: accounting style, negatives in brackets `(1,234.56)`; store signed by cash direction (outflow negative). Existing expenses rows migrate to negative.
- Prep spike + scope instructions: DONE.

**Open for the plan:** bill split-coding (one row per bill line item, recommended) · keep `expenses` name vs rename · de-dup join (`transfers.payment_id` ↔ `bill.payment`) · counterparty→CoA rule table for uncoded bank lines · `unclassified` holding state (no silent drops). Bank lines need counterparty mapping, not GL. Related: [[project_excise_channel_liability]] (statements consumers).

## IMPLEMENTATION COMPLETE (2026-07-09)
Both plans built + reviewed via subagent-driven-development on branch `claude/ramp-bills-expenses-sync-5777eb` (tip `d0e506f`). 19 tasks, all reviews clean; final whole-branch review (opus) = merge-with-fixes, fixes landed. Gate green: tsc/lint(0 err)/774 tests/build. Plans: docs/superpowers/plans/2026-07-08-ramp-bills-to-expenses.md + 2026-07-08-ramp-bank-ledger.md.
- Plan A: bills→expenses line-item grain; accounting sign flip (outflow negative, brackets); extractGlAccount external_code fix; route/cron/webhook wired; Expenses tab bill badge.
- Plan B: `ramp_bank_ledger` table + `classifyBankLine` (drift-critical) + counterparty→CoA rules + `syncAllRamp` + Bank Ledger tab + counterparty settings.
- **MIGRATIONS PENDING MANUAL PROD APPLY (gated):** `20260724_expenses_ramp_object_and_sign.sql` (NOTE: contains a one-time NON-idempotent `amount_cents` sign flip — needs backup) + `20260725_ramp_bank_ledger.sql`. Live browser verification of both tabs blocked until applied.
- Bugs caught by review gates (fixed): B5 whitespace-destination → silent operating_expense (drift); B7 syncBankLedger untested manual-preservation + swallowed select error; final review: manual flow_type recode clobbered on re-sync + syncExpenseRecords swallowed select error.
- **Non-blocking follow-ups:** chunk() dedup → lib/utils; getRampBankTransactions unwindowed full-scan; isRampCard `/ramp/i` heuristic (card-autopay detection unvalidated vs real data — re-run scripts/ramp-api-spike.mjs over a longer window); rampExpenses.ts inherited-pattern review; bank-ledger unused CoA join. Spike script `scripts/ramp-api-spike.mjs`. Statements rework is the NEXT project, on this cleaned basis.

## POST-MERGE (2026-07-09): PR #134 merged, migrations applied
- **PROD SCOPE BUG found + fixed (PR #135):** `/banking/*` endpoints REQUIRE `treasury:read` — token mints without it but banking calls 403 ("These scopes are not allowed for this token: treasury:read"). Mocked unit tests couldn't catch it; live verify did. `banking:read` alone is insufficient. RAMP_SCOPES now includes treasury:read.
- **Live read-only verify PASSED** (shipped classifier vs real Ramp): schema live; 23 bank lines → 18 operating_expense (Gusto/Erie/NC DEPT REVENUE/AutoChlor), 2 interest_income, 1 bill_settlement (excluded), 2 deposit (parked); anti-drift invariant held. 8 bills → 30 line-item records (5 split).
- **CONFIG WATCH-ITEM:** tax-remittance counterparties (e.g. NC DEPT REVENUE) classify as operating_expense and seed an unmapped counterparty rule — map them to a LIABILITY/tax account (not an expense) in Settings → Counterparty Accounts so P&L isn't overstated. Same for any pass-through. Deposits/transfers/settlements are auto-excluded from P&L.
- Tables are empty until a sync runs (daily cron / webhook / "Sync Ramp" button) — verify did NOT write to prod. UI browser verification still pending (needs authed session; can't drive headless).

## CORRECTION (2026-07-09): card statement payments are in /transfers, NOT ingested
- **Gap found by user:** card statement autopayments (e.g. Jun 26 -$6,880.82) live in the `/transfers` endpoint, which the shipped code does NOT fetch/ingest at all. `/banking/syncable-transactions` (what getRampBankTransactions pulls) does NOT contain them. So `isRampCard` in classifyBankLine is DEAD/misplaced — card payments never appear in syncable-transactions.
- `/transfers` is sparse: {id, amount, payment_id, status, created_at, bank_account_id} — NO description/counterparty/type. Can't self-identify as a card payment.
- **No P&L drift today** (transfers un-ingested; card charges counted once via getRampTransactions→expenses). But the Bank Ledger cash view is INCOMPLETE (missing these outflows → doesn't reconcile to bank balance).
- **Identification confirmed via /statements charges:** Jun transfer $6,880.82 == Jun statement charges $6,880.82 (exact); May transfers $11,337.59+$1,588.56 == May statement charges $12,926.15 (summed). NOTE: statement `payments` field lags a period — match on `charges`, not `payments`.
- **DONE — PR #142 (branch claude/ramp-transfers-ingest), reviewed clean:** getRampTransfers fetcher + classifyTransfers → transferToLedgerRecord (affects_pl=false, outflow-negative) → syncBankLedger. No migration (card_settlement/unclassified already in flow_type CHECK). User chose robust statement-charge matching.
  - classifyTransfers: filters to status==COMPLETED; Pass-1 exact match transfer==statement.charges; Pass-2 tags leftover (>1) only when their sum == a SINGLE remaining charge (split payments); else unclassified. Match on statement CHARGES not payments (payments lag a period).
  - Review-hardening (commit 0ed3dd8): rerouted the dead isRampCard branch in classifyBankLine from card_settlement → internal_transfer so card_settlement has ONE source (/transfers), never double-produced across feeds. Verified 0 ramp-card destinations in real syncable-transactions feed, so no actual double-count existed.
  - Live-verified: Jun $6,880.82 exact; May $11,337.59+$1,588.56 summed → all card_settlement.
- **isRampCard branch REMOVED (PR #143):** dead code deleted; a Withdrawal to an external party in syncable-transactions is now directly operating_expense (card settlements come solely from /transfers). All Ramp ledger PRs merged: #134/#136/#138/#142; #143 open.
- **STILL USER-SIDE:** run a first sync (cron 06:30 / Sync Ramp button / webhook) to populate tables; then map counterparties in Settings (Gusto→Payroll, Erie→Insurance, NC DEPT REVENUE→liability/tax NOT expense); UI eyeball needs authed session. Statements rework = separate NEXT session on this basis.
