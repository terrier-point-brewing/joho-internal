---
name: project_tax_tab_search_filter_backnav
description: "Finance > Tax tab UI cleanup — search/filter on task list + back link on worksheet pages, PR"
metadata: 
  node_type: memory
  type: project
  originSessionId: 3221df37-a912-43da-a392-0f6365606d20
---

2026-07-17: Finance > Tax tab UI cleanup — **PR #223 MERGED** (squash, `1b2439e`), worktree `finance-tax-ui-cleanup-b3e6c7` removed, local branch force-deleted (squash-merge, not a literal ancestor of main — confirmed via `gh pr view --json mergedAt` + `git log origin/main` before force-delete).

**What shipped:**
- `app/finance/tax/TaskList.tsx` — added the app's standard `useTableControls` (search on party label + notes + confirmation #, `FilterChips` filter on party, hidden when only one party exists). Filtering runs before the existing Open/Completed grouping split, so that grouping is preserved.
- `app/components/ui/BackLink.tsx` (**new**) — plain `← Back` text link. This is the **first "back to list" nav convention in the app** — no prior detail page (incl. `app/finance/payroll/[periodId]/`) had one; that page uses a `PeriodSelector` dropdown instead. Reuse this component for future detail/subroute pages rather than inventing another back-link style.
- `app/finance/tax/[taskId]/TaxWorksheetShell.tsx` — wired `<BackLink href="/finance/tax" label="Tax" />` into all three render states (loading/error/loaded).

**Deliberately left alone:** `ScheduleList.tsx` (filing schedules) — too few rows (~1 per party×frequency) to justify search/filter, same reasoning already applied to Payroll Periods per [[project_search_filter_standards]].

Related: [[project_finance_ui_conformance]] (broader Finance UI-standard pass), [[project_wake_county_food_beverage_tax]] (3rd tax party, grew the task list this cleanup targets).

**Open:** live browser verification never done — app is login-gated and no dev/test credentials exist in the sandbox (same gap noted across prior tax-module work).
