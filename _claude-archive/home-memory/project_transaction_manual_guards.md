---
name: project-transaction-manual-guards
description: "2026-07-24 Transactions exclude-as-duplicate + manual GL split guards, plus the buildBillTotals double-count fix that stranded a duplicate Duke Energy expense"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6cb98cec-f4fc-46d3-88fe-55fcf1c62452
  modified: 2026-07-25T02:24:57.910Z
---

2026-07-24. Branch `claude/dukeenergy-duplicate-pl-check-c039a5`. **PR #266 OPEN**, not merged. `npm run verify` green (1899 tests).

**Migration tracking gotcha:** `supabase_migrations.schema_migrations` is EMPTY above `20260810` — migrations on this project are applied by hand via SQL, so the tracker does NOT reflect reality. Never infer applied-state from that table; probe for the actual object (`to_regclass`, or `information_schema.columns`). Verified 2026-07-24 that `20260814` and `20260815` were already applied despite memory claiming both pending.

**Root cause found first:** Duke Energy was double-counted on the P&L for $4,833.55 (June bill `7e05e00b…` 12 lines + July bank line `38ba080d…`, both → `COGS:…:Brewery Utilities`). `buildBillTotals` accumulated by bill id with **no per-line dedup**, and `rampSync.ts` feeds it two overlapping lists (bill lines persisted in `expenses` over 120 days + bills freshly fetched from the Ramp API). A bill in both summed to 2×, matched no real bank debit, so the settlement check failed and the bank line was booked as a second expense. The daily cron's 45-day API window triggers it; the webhook's 2-day window does not — which is why exactly one row stranded. **The wider window is what breaks it**, the opposite of the intent commented at `rampSync.ts:15-19`.

**Shipped:** migration `20260816_expense_manual_guards.sql` (`expenses.excluded_at/_reason/_by` + `expense_gl_splits.memo`); exclusion filtered at one point via new shared `lib/finance/financials/expenseFilters.ts` (both `fetchSources` and `scripts/financials-parity.ts` call it — they had already drifted once); manual splits reuse the pre-existing `expense_gl_splits` + its already-correct aggregation (`split_source='manual'` was a designed-in but unused escape hatch); `buildBillTotals` per-line dedup; guarded prune of stale `expenses` rows for reclassified bank lines.

**Durable gotchas learned here:**
- `payroll_period_expense_matches.expense_id` FK is **NO ACTION**, while `expense_gl_splits.expense_id` **CASCADEs** (same migration `20260714`, lines 60 vs 67). Deleting an expense with a payroll match throws and, if unguarded in a chunked delete, aborts the whole sync. **All 15 payroll matches in prod are `ramp_object='bank'` (GUSTO)** — exactly the class the prune targets, so this was reachable, not theoretical.
- Any new `expenses` column must stay **out of `ExpenseRecord`** (`lib/finance/expenses.ts`) or `syncExpenseRecords`'s upsert wipes it every sync. Same guarantee as `unmapped_accepted`/`inventory_alert_dismissed`.
- The P&L **replaces** a split expense's own coding with the union of ALL its `expense_gl_splits` rows regardless of `split_source` (`aggregateRows.ts:305-312`). So writing manual splits onto an expense that already has `payroll_auto` splits double-counts it — validation can't catch this, since the manual lines balance against the parent on their own.

**⚠️ HARD DEPLOY GATE:** migration `20260816` is unapplied and is the ONLY outstanding one (`20260814`/`20260815` verified applied). Deploying first 500s **P&L + Cash Flow + Balance Sheet**, the Transactions>Expenses page, and the payroll-match route. Ramp sync degrades gracefully (prune is best-effort, reports `pruned.error`). The stranded Duke row clears itself on the first post-deploy sync — no data migration.

**Never browser-verified** (auth-gated + unapplied migration). Deferred follow-ups are listed in `.superpowers/sdd/progress.md` on the branch — notably: split DELETE can un-pin a hand-set GL account, Transactions stat tiles still include excluded rows, and no IO-level test for `pruneReclassifiedBankExpenses`.

Spec: `docs/superpowers/specs/2026-07-24-transaction-manual-guards-design.md` · Plan: `docs/superpowers/plans/2026-07-24-transaction-manual-guards.md`. See [[feedback-final-review-catches-real-bugs]] — it happened again here.
