---
name: project-payroll-gl-account-split
description: "Payroll GL account split via Gusto CSV upload — split payroll bank withdrawals across GL accounts, merged PR"
metadata: 
  node_type: memory
  type: project
  originSessionId: bf2a7637-ba37-4fac-aad2-bedf002cd197
---

2026-07-14/16: Finance > Transactions can now split Gusto payroll bank-withdrawal `expenses`
rows across GL accounts 6110 (taproom wages), 6120 (admin wages), 5130 (production labor), 6130
(payroll taxes), driven by uploading Gusto's Payroll Journal Report CSV per pay period in the
Payroll module. **MERGED to main via PR #200** (squash, commit `c28f4f6`); worktree/branch
cleaned up.

Architecture: new generic `expense_gl_splits` table (mirrors `invoice_line_items`) lets any
`expenses` row carry multiple GL lines instead of one `chart_of_accounts_id` — only this payroll
flow writes to it. Financials reads through one shared resolver (`getExpenseGlLines` /
`resolveExpenseGlLines` in `lib/finance/expenseGlLines.ts`) so no other code special-cases
payroll. Matching/auto-fill logic in `lib/finance/payrollMatching.ts`
(`suggestPayPeriod`/`computeProportionalSplits`/`recomputePeriodExpenseSplits`). Gusto CSV parsing
in `lib/payroll/gustoParser.ts`. Migration `20260714_payroll_gl_split.sql`. Design doc:
`docs/superpowers/specs/2026-07-14-payroll-gl-account-split-design.md`; plan:
`docs/superpowers/plans/2026-07-14-payroll-gl-account-split.md`.

Built via subagent-driven-development across 7 locality groups. Three real dollar-correctness
bugs caught by review before merge: (1) Gusto upload wasn't atomic against partial DB failure
(fixed: Storage-then-DB ordering, compensating deletes, old report superseded last); (2) the
proportional-split algorithm could produce GL lines for an expense that didn't sum to that
expense's own amount whenever a period's Gusto-report total didn't exactly match its
matched-transactions total (fixed: derive each bucket's ratio from the period total, apply to
each expense independently — invariant now holds by construction); (3) **caught only in the
final whole-branch review** — `expense_gl_splits.amount_cents` was stored positive instead of
preserving the parent expense's cash-direction sign, which would have inverted the P&L for every
split payroll transaction (expenses are stored negative for outflows; Financials'
`normalizeSignedCents` passes expense/bank P&L amounts through unchanged, trusting the caller's
sign). Fixed + covered by a write→read integration test. [[feedback_final_review_catches_real_bugs]]

**Real PII incident caught by the platform's safety classifier, not by me**: while building the
Gusto CSV parser test fixture, a subagent inlined the user's actual real Gusto payroll export
(real employee names + real wages + real tax withholding) directly into a *committed* test file
(`lib/payroll/gustoParser.test.ts`), and separately I hand-wrote real employee names/dollar
breakdowns into the implementation plan doc while verifying parsing logic — both went into local
git history. The first `git push` attempt was blocked by the harness's data-exfiltration
classifier before anything reached GitHub. Remediated by rewriting the branch's entire local
history (21 commits replayed, real names replaced with fictional ones consistent across all
files, exact same numeric structure preserved so all verified test math held) — required explicit
user confirmation of the *specific* remediation plan, not just a generic "yes", per the
classifier's own message. [[feedback_real_pii_in_test_fixtures]]

**2026-07-16: migration APPLIED to prod by user** — was the root cause of a live "Could not find
the table 'public.expense_gl_splits' in the schema cache" error that took down the whole Finance >
Financials view (Financials queries `expense_gl_splits` unconditionally via
`lib/finance/financials/fetchSources.ts`). Verified in prod: all 7 GL-split tables present,
`payroll-gl-reports` bucket present, `routing` column added, `expense_gl_splits` queryable (0 rows).
Prereq fns (`payroll_reader_roles`/`finance_reader_roles`/`get_my_role`/`update_updated_at`) already
existed. Lesson: shipping code that unconditionally queries a new table while its migration stays
human-gated will hard-break the reading page in prod until the migration lands.

Human-gated follow-ups (still open): seed `payroll_department_gl_mappings` for real Gusto department
names + set the payroll-taxes account in settings, set Gusto's counterparty row to
`routing = payroll_split`. (Until then, split payroll expenses fall back to their single-account GL
mapping.)

**2026-07-16 follow-ups this session:**
- **May pay periods backfilled in prod** (3 rows inserted directly, idempotent `on conflict(start_date)`):
  `2026-05-04→05-17`, `05-18→05-31`, `06-01→06-14` (all `status=open`, `due=end+1`). Timeline now
  contiguous May 4 → Aug 9. `pay_periods` real columns are `start_date/end_date/due_date/status`
  (NOT the design's `period_start/pay_day`). Biweekly grid: `end=start+13`, next `start=prev end+1`.
- **Payroll periods table UI upgrade — PR #211 MERGED** (commit `0cad064`; also carried a Financials
  frozen-column fix). Rewrote Finance→Payroll list onto the standard table
  kit + per-period rollups: app basis / Gusto result / drift / matched-txns / reconciliation / splits.
  **Key fact: the app-side payroll basis is NOT stored separately — the lock route
  (`app/api/payroll/periods/[id]/lock/route.ts`) already snapshots effective hours/tips/bonus into
  `payroll_entries` at lock, so basis is computed DB-only for LOCKED periods (open periods show `—`).
  The entries SAVE route only persists `adj_*`+notes; live hours/tips come from Square each preview.**
  Logic in `lib/payroll/periodSummary.ts` (pure + batched, no Square); no migration. Verify green 1596.
**Browser click-through verification of the 3 new UI surfaces (settings toggle + department
mappings page, Payroll Gusto Upload tab, Transactions PayrollSplitCell) was never done** —
orchestrator hit a login wall with no test credentials available in this environment; only
static checks (build/typecheck/raw-color grep) + confirmed no server crash.

**2026-07-16: Taproom↔Finance payroll UI consolidation — PR #214 MERGED** (squash `f6f1ed2`;
worktree/branch cleaned up). Both `/taproom/payroll/[periodId]` and `/finance/payroll/[periodId]`
already rendered the SAME shared `app/components/payroll/PayrollPeriodView` — the whole divergence
was just two props. Now the canonical model: **Finance = full + editable** (tabs `summary`,
`shifts`, `gusto`, `gustoUpload`; `/finance/**` is admin-gated at the layout so it's always
editable), **Taproom = light + read-only** (tabs `summary`, `shifts`; `editable={false}`). The
`tabs` prop IS the access-control lever — the Gusto/GL tabs simply aren't mounted in the Taproom
route. **Behavioral change: overrides + Lock Period now live in Finance ONLY** — Taproom admins can
no longer lock a period (previously `editable={isAdmin}` there); Taproom is a pure viewing surface.
Also deleted the dead single-tab `PayrollNav` and the `/finance/payroll/settings`→`/finance/settings/payroll`
redirect. Deliberately left `/finance/settings/payroll` untouched (its `accent-amber-500` checkboxes
match the app-wide convention; local `inputCls`/`labelCls` already pass CI — a rewrite is
regression-prone polish, not a real violation). Rebased on top of #211 mid-PR: kept #211's rich
`PeriodsTable` wholesale, my only list-page delta was swapping `PayrollNav`→`FinanceNav`. Same
login-wall caveat: no logged-in visual pass, static checks only (verify green 1605).

**2026-07-16: 4 payroll-split treatment fixes — MERGED via squash PR #215 (`ae074aa`);
worktree/branch cleaned up. Verify green 1608.** User-reported issues on Transactions→Expenses. Verified everything
against PROD via a throwaway `buildFinancials` probe (worktree has no node_modules → ran the probe from
the MAIN checkout with the fix mirrored in, then `git checkout` to revert main; `.env.local` has
`SUPABASE_SERVICE_ROLE_KEY`):
1. **Split display moved out of the GL-Account cell into the row's transaction dropdown.** Split
   `PayrollSplitCell.tsx` into `PayrollSplitSummary` (compact non-interactive badge in the GL Account
   column: "Payroll {period} · split (N)" / "· awaiting Gusto" / "· unmatched") + `PayrollSplitPanel`
   (the expanded row body: period label, per-line breakdown + Total, Match/Recompute/Unmatch actions,
   added Unmatch). Page renders the single-account `AccountSelect` for normal rows, the panel for
   payroll rows.
2. **Mapping pill said "unmapped" for fully-split rows** because payroll-split expenses keep
   `chart_of_accounts_id = null` (they code via `expense_gl_splits`) and the pill/filter/counter all
   read that column. Fix: unified `mapped` signal to `glLines.length > 0` (helper `isExpenseMapped` in
   page.tsx) — glLines already encodes both paths (synthesized single line for normal, split lines for
   payroll), so one signal fixes pill + mapping filter + "Mapped X/Y" counter for all rows.
3. **Splits ALREADY roll into the P&L correctly** (4 rows: 5130 Direct Production Labor under COGS,
   6110/6120/6130 under OpEx — accounts have `statement_section=null` but infer P&L via `account_type`;
   split amount_cents are negative; June/July 2026 populated). **The real bug was Cash-Flow-only**: 0
   payroll rows there. Root cause: `lib/finance/financials/fetchSources.ts` `fetchExpenses` cash filter
   was `.eq("state","CLEARED")` (uppercase, matches Ramp *card* rows) but *bank* rows — every Gusto
   withdrawal — are written `state="cleared"` (lowercase, `bankLedger.ts` line ~105, deliberate for the
   green badge). Fixed to `.ilike("state","cleared")` → all 21 bank expenses (incl. payroll) now appear
   in cash flow; probe confirmed the 4 rows now present with identical totals. NOTE remaining pre-existing
   gap (left out of scope): bill rows settle `state="PAID"` and are STILL excluded from the cash view.
4. **New "Auto-map payroll" button** next to "Auto-map all". Bulk analog of the per-row match. Pure
   `planPayrollMatches(expenses, periods)` + DB wrapper `autoMapPayrollExpenses(sb,{from,to,matchedBy})`
   added to `lib/finance/payrollMatching.ts` (loads `payroll_split`-routed counterparties → unmatched
   bank expenses in range → nearest pay period via existing `suggestPayPeriod` → inserts matches →
   recomputes each touched period; only ADDS matches, safe to re-run). Route
   `app/api/finance/expenses/auto-map-payroll/route.ts` (manager+). `AutoMapButton` generalized to
   generic `<T>` with optional `label`/`busyLabel`/`renderResult` (defaults keep the `{mapped}` shape).
Same login-wall caveat — no logged-in visual pass on the new UI (verify green + live financials probe only).
