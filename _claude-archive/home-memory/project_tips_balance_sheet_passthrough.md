---
name: project-tips-balance-sheet-passthrough
description: Tips were a one-sided P&L expense; branch routes both legs to a liability account. 2 migrations PENDING and merging breaks Gusto upload until applied
metadata: 
  node_type: memory
  type: project
  originSessionId: f640f4d2-56fe-4eae-ab9c-970d17ef332f
  modified: 2026-07-29T02:11:13.657Z
---

2026-07-28. **PR #283 MERGED** (squash → `25bff02`) and follow-up **PR #284 MERGED** — a preview-gated backfill UI on Finance → Payroll, because the backfill shipped API-only and hand-posting JSON is no way to run a financial operation.

✅ Migrations 20260823 + 20260824 **APPLIED** (verified 2026-07-28). ⚠️ The **backfill has NOT been run** — until it is, May–Jul wage/COGS accounts still carry ~$900–$1,050/period of tips. Preview writes nothing; the Run button stays disabled until a preview comes back clean (every period's bucket total unchanged, no errors).

⚠️ I pushed that UI commit to the #283 branch *after* it was squash-merged, stranding it — had to re-branch off main and cherry-pick. Re-check PR state before every push; see [[feedback_subagent_git_stash_hazard]]'s sibling note in the index.

**The bug.** Tips were excluded from P&L revenue but included in P&L expense. `computeProportionalSplits` forced every matched expense's GL lines to sum to the Gusto bank debit — which carries paycheck tips — so tip dollars were smeared onto wage and COGS accounts. Understated operating income ~$900–$1,050/period (~$2k/month); part of it inflated COGS, so gross margin and $/BBL were off too. Verified on 2026-06-01→14: debits $7,943.72 vs GL totals $6,209.71, tips $911.58, unexplained residual $822.43.

**The fix.** Both legs post to `payroll_gl_settings.tips_chart_of_accounts_id` (an Other Current Liabilities account), so tips are excluded from the P&L *structurally* — `summaries.ts`'s `PL_SECTIONS` never sums that section. Payout = exact tip carve-out from the Gusto CSV before the pro-rata fill. Collection = derived-on-read monthly accrual from `square_orders.tip_cents`, balance-sheet mode only, no new table.

⚠️ **PENDING: migrations 20260823 (tips account) + 20260824 (bucket_kind).** Merging **breaks** `GET`/`PUT` payroll-department-mappings (whole settings page 500s), the Gusto CSV upload, and every `recomputePeriodExpenseSplits` caller (payroll-match action on Expenses) until both are applied — PostgREST 400s on a missing column. Apply in the same maintenance window as the deploy, not after. `fetchTipsAccountId` degrades deliberately, so Financials never breaks. Then run the backfill dry-run (defaults `dryRun: true`) before the live run. Full ordered sequence + break list is in the spec's Deployment section.

**Durable gotchas found here:**
- `normalizeSign` had a real pre-existing bug: expense/bank on a BS **liability** section returned `-magnitude`, growing a liability when you pay it down (2 live NC DOR rows hit it). Correct rule is `-rawCents` — **except** `statementSection === "bank"`, where `ramp_bank_ledger` rows ARE the cash account's own ledger and raw already expresses balance direction, so it must return `rawCents`. Getting that carve-out wrong twice (first `-rawCents` everywhere in my spec, then `magnitude`) took two review rounds to settle.
- A pre-existing test can pin the bug you're fixing: `aggregateRows.test.ts` expected `-100000` where `-30000` is correct. Re-derive from the fixture; don't accept "the reasoning sounds right".
- `bucket_kind` filters must test `!== "tips"`, never `=== "wages"` — migration `20260824`'s `DEFAULT 'wages'` stamps existing employer-tax rows as wages too.
- Square **payments** are not persisted (live-fetch only) and `square_refunds` has no tip breakdown, so the pooled payroll tip basis (payments net of refunds, floored per payment) cannot be reproduced from tables. That's why the accrual uses gross order tips and the liability carries a small permanent credit.

Related: [[feedback_frozen_tests_as_equivalence_gate]], [[feedback_final_review_catches_real_bugs]], [[feedback_prod_db_migration_authorization]], [[project_payroll_gl_account_split]].
