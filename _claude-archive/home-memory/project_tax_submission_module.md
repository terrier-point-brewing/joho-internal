---
name: project_tax_submission_module
description: "2026-07-12 tax submission module (Finance → Tax) — FULLY BUILT & green on branch; human-gated deploy steps pending"
metadata: 
  node_type: memory
  type: project
  originSessionId: 00cd17ff-16ed-4d05-935b-5d3b5baf00ef
---

New Finance → Tax module for preparing monthly/quarterly/annual tax submissions to external receiving parties. First party = **NC DOR Sales & Use Tax**.

**Status (2026-07-12): IMPLEMENTATION COMPLETE & GREEN** on branch `claude/tax-submission-module-77e7f2` (worktree, HEAD after 3b0ceab). All 20 plan tasks + a purchases-for-use enhancement (10b) built via subagent-driven-development; each per-task reviewed + a final Opus whole-branch review (verdict ready-after-fixes, NO Critical; the 2 fast-follow fixes applied). **1140 tests pass, `npm run build` green.** NOT merged; branch not pushed unless done separately.
- Spec: `docs/superpowers/specs/2026-07-11-tax-submission-module-design.md`
- Plan: `docs/superpowers/plans/2026-07-11-tax-submission-module.md` (20 tasks, model column).

**HUMAN-GATED before it works in prod (per [[feedback_prod_db_migration_authorization]]):**
1. Apply migrations `20260711_pos_line_item_taxes.sql` + `20260711_tax_module.sql` (5 tables + private `tax-confirmations` Storage bucket — FIRST Storage use in app).
2. Run backfill `GET /api/tax/backfill-line-item-taxes?start=&end=` (admin/CRON_SECRET) for the target tax year. Depends on Square order history in pos_line_items (see [[project_financials_consolidation]] — limited history until backfilled).
3. Set `NEXT_PUBLIC_APP_URL` in Vercel (else alert-email links → localhost). Confirm `CRON_SECRET` + `RESEND_API_KEY`.
4. Create first NC DOR schedule (Finance→Tax) + Tax Filing identity (Finance→Settings→Tax Filing). `tax-tasks` cron = daily 08:00 UTC (in vercel.json).

**FEIN sensitivity waiver (user-approved 2026-07-12):** `fein` deliberately NOT masked (business ID, read-off-to-file in worksheet header); only `ssn` masked/write-only. Recorded in spec §3.2. Tables still service-role-only + manager+-gated.

**PR #171** (whole module) SQUASH-MERGED to main. Both migrations + `tax-confirmations` bucket APPLIED to prod (table exists, 0 rows). 

**Backfill DONE + VERIFIED (2026-07-12).** Fixed a **1000-row PostgREST truncation bug** in `backfillLineItemTaxesForRange` (single unpaginated select capped square_orders AND pos_line_items) → **PR #172 MERGED**. Then RAN the backfill for 2026-01-01..07-13 (via a local paginated batched replica script + SERVICE_ROLE key, since deployed route needs CRON_SECRET not in local env): **5002 rows written across 1174 orders**. VERIFIED: all 2712 lines-with-tax reconcile exactly to `pos_line_items.tax_cents` (0 mismatches). POS data spans 2026-05-15..07-12 only.
- **General Sales Tax square id = `ADD7EKQD2KN72NOYVUWHU34J`** ($1579.21, 2712 rows) ← configure this as `general_sales_tax_id` in Finance→Settings→Tax Filing. (Other: Prepared Food & Beverage Tax `ARI25PLSGLDVIBUQITKTRNSX`, $139.65.)
- STILL TODO (user): set `NEXT_PUBLIC_APP_URL` in Vercel; create first NC DOR schedule + fill Tax Filing identity (incl. the General Sales Tax id above).

**Tracked follow-ups (non-blocking):** autosave has beforeunload guard but no auto-retry; no exact lookback-boundary unit test. Spawned separately: pre-existing `autoMap.ts` bug (`square_order_id` col missing on pos_line_items, task_f49a0d2d).

**Architecture decisions locked (via brainstorming):**
- Party-template registry: thin party-agnostic engine `lib/tax/` (types/registry/period/schedules/tasks) + self-contained party modules `lib/tax/parties/<party>/` plugging into `TaxPartyTemplate`. UI `app/finance/tax/`, settings `app/finance/settings/tax-filing/`.
- **Data source (user chose):** EXTEND POS sync to persist per-line tax breakdown → new child table `pos_line_item_taxes` (line→taxes is 1:many; SQL aggregation). Backfill route for history. NOT live-Square-fetch.
- Tables: `pos_line_item_taxes`, `tax_filing_profiles` (party-level identity, service-role-only, FEIN-first SSN optional), `tax_schedules` (party-agnostic; counties live in `config` jsonb NOT a column), `tax_tasks` (unique(schedule_id,period_end)), `tax_task_files` (free-form multi-file labeled uploads). New private Supabase Storage bucket `tax-confirmations` (first Storage use in app).
- Full editable worksheet mirroring the NC DOR form (not read-off card); saved worksheet = audit record.
- Recompute is PARTY-OWNED via computed/manual field-ownership + `mergeWorksheet` — framework has no hardcoded Square dependency.
- Statutory rates (4.75% state, county tier chart 2.00/2.25/2.50/2.75) = code constants in party module, VIEWABLE via reference disclosure, NOT user-editable. User-controllable (counties+weights, which Square tax item = General Sales Tax, lead days, identity) = stored settings. Multi-county split IN SCOPE for NC DOR.
- Gross Receipts (Line 1) = Σ(total_money − total_tax) over lines carrying the configured General-Sales-Tax square id (excl. tax + tips); = taxable base on rate lines. Wake = General State 4.75% + County 2% + Transit 0.5%; others 0.
- Alerts: BOTH in-app (Tax tab badges) + Resend email at due − lead_days (default 7). Cron `app/api/cron/tax-tasks` daily.

**Human-gated post-merge:** apply migrations `20260711_pos_line_item_taxes` + `20260711_tax_module`; run backfill for target year; create first NC DOR schedule + identity profile; confirm CRON_SECRET + RESEND_API_KEY in Vercel. Per [[feedback_prod_db_migration_authorization]].

**PROD STATE (2026-07-12, branch claude/nc-dor-sales-use-tax-f18603):** First NC DOR schedule now EXISTS in prod `tax_schedules` (id `aaab1d72-e04a-4ecb-b1f3-ab19ee506e03`; monthly, lead_days 7, active, config.counties=[{WAKE,100}]; created ~2026-07-13 UTC). Tax Filing identity profile also present (`tax_filing_profiles` row for nc_dor_sales_use: fein/account_id/contact_*/general_sales_tax_id). Manually **backfilled the June 2026 tax_task** (id `a16325d8-...`; period 2026-06-01→06-30, due **2026-07-20**, status open, worksheet null) via direct INSERT mirroring `ensureTasksForSchedule` (idempotent ON CONFLICT (schedule_id,period_end)). Reason it was missing: schedule created same day, daily 08:00 UTC cron `/api/cron/tax-tasks` hadn't run yet — NOTE: **task creation is cron-only, NOT an on-save side-effect** (schedule POST just inserts; no trigger). Due-date logic VERIFIED correct: monthly → 20th of following month (party-template `monthlyDue`), not the generic lastDayOfFollowingMonth (that's quarterly). June has Square tax data to recompute from (1538 rows / 363 orders / $548.83) — but heed the June'26 POS sync gap (~50% orders missing, see [[project_financials_consolidation]]) before filing. User will run "Recompute from Square" from the UI later. Still TODO: confirm NEXT_PUBLIC_APP_URL set in Vercel.

**GROSS-RECEIPTS UNDERCOUNT BUG — ROOT-CAUSED & FIXED (branch claude/nc-dor-sales-tax-discrepancy-a7f995, NOT merged):** June 2026 task worksheet stored `line1_gross_receipts = $7,535.91`, ~half the true ~$14,233.61. Cause = **same 1000-row PostgREST truncation** as the backfill bug: `fetchTaxableBase` in `lib/tax/parties/ncDorSalesUse/calc.ts` did an UNPAGINATED select and June had **1863** qualifying `pos_line_item_taxes` rows → capped at 1000 → base $7,535.91, collected $546.60 (true $1,032.43). Nasty: collected truncates in lockstep with computed tax, so the reconciliation warning (calc.ts ~L145) scales down together and NEVER fires. Fix: extracted `fetchAllRows` into a NEW shared module **`lib/supabase/paginate.ts`** (moved out of `lib/finance/financials/fetchSources.ts`, which now re-exports it; tests moved to `lib/supabase/paginate.test.ts`) and paginated `fetchTaxableBase` (stable `.order("line_item_id")`, injectable pageSize). Verify GREEN (1380 tests). Verified vs live data: paginated → $14,233.61 base / $1,032.43 collected. **OPEN ACTION (human, in-app): stored June task still shows the stale $7,535.91 — re-run "Recompute from Square" on the June task after this merges; stale worksheets do NOT auto-update.** Sibling risk flagged (task_c76906de): beer-excise `fetchExciseData` (`lib/tax/parties/ncDorBeerExcise/calc.ts`) has the same unpaginated pattern over `export_transactions` (lower risk, smaller table).

Related: [[project_excise_channel_liability]] (other tax reporting), [[project_financials_consolidation]] (original 1000-row truncation bug class), [[feedback_subagent_worktree_cwd]] (pin cwd when executing).
