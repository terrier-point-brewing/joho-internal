---
name: payroll-gl-split-month-proration
description: "Payroll GL split amounts now prorate across the months a pay period spans instead of using the transaction's posting date"
metadata: 
  node_type: memory
  type: project
  originSessionId: e3458e36-aef1-4018-8bac-37fc1c10ec5a
---

2026-07-17: pay periods spanning a month boundary (e.g. last week of May + first week of June) previously attributed the ENTIRE `expense_gl_splits` amount to whichever month the Gusto withdrawal happened to post in (`accounting_date`), misstating both months' P&Ls. Fixed via a new pure function `prorateAcrossMonths` (`lib/finance/payrollPeriodProration.ts`, day-count proration + largest-remainder rounding), shared by server-side `aggregateRows.ts` (P&L attribution) and client-side `PayrollSplitPanel` (Transactions UI breakdown display).

**No schema change, no migration, no backfill** — computed at read time from `pay_periods.start_date`/`end_date` (already stored), so it retroactively fixes every historical matched pay period the moment it ships. `fetchExpenses` gained a batched join (`payroll_period_expense_matches` → `pay_periods`, two flat queries not an embed) attaching `payrollPeriod` to each expense.

Design decision worth remembering: once an expense is matched to a pay period, month attribution is driven ALWAYS by the pay period's own dates — even for a single-month period whose transaction posts in a later month (processing delay). This replaces `accounting_date` as the attribution basis entirely for matched expenses, not just cross-month ones.

**PR #226, OPEN (not yet merged)**, branch `claude/payroll-transaction-month-split-01849c`, worktree kept alive for review iteration. `npm run verify` green (1650 tests, +10 new). Browser E2E NOT verified — no app login credentials available in this session (recurring limitation, see [[project_wake_county_food_beverage_tax]] and others for the same gap).

Design spec: `docs/superpowers/specs/2026-07-17-payroll-gl-split-month-proration-design.md`. Plan: `docs/superpowers/plans/2026-07-17-payroll-gl-split-month-proration.md`. Builds on [[project_payroll_gl_account_split]].
