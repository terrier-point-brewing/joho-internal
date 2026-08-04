-- Payroll matching by amount instead of by date.
--
-- A Gusto pay run leaves the bank as TWO separate ACH pulls -- one for
-- disbursements, one for tax remittance -- and the Ramp/Plaid feed reports each
-- as its own transaction. Until now nothing in the database knew what those two
-- amounts should be, so `payroll_period_expense_matches` was populated by
-- proximity: nearest pay period whose end_date is within 10 days
-- (lib/finance/payrollMatching.ts's suggestPayPeriod). Proximity cannot tell a
-- payroll debit from anything else the same counterparty bills in the same
-- fortnight -- which is how Gusto's monthly software subscription ended up
-- inside pay periods, and (because computeProportionalSplits force-fills the
-- reconciliation residual onto wage/tax accounts) booked to the P&L as wages.
--
-- The Gusto payroll journal already carries the answer per employee: "Check
-- Amount", "Employee Taxes", "Employer Taxes". Summing them gives the two
-- debits BEFORE the bank is consulted, so matching becomes exact-amount rather
-- than nearest-date, and anything left over is non-payroll by construction --
-- no amount rule to go stale when Gusto's per-employee price changes.

-- ── What the report says will leave the bank ─────────────────────────────────
-- Nullable on purpose: every report uploaded before this migration was parsed
-- without these columns and has no values to backfill from the row itself. The
-- source CSVs are still in the `payroll-gl-reports` bucket, so a backfill can
-- re-parse them (see the payroll GL-report backfill route); until it runs,
-- NULL means "this report predates amount matching" and the matcher skips the
-- period rather than guessing.
alter table payroll_gl_reports
  add column if not exists expected_net_pay_cents        bigint,
  add column if not exists expected_tax_cents            bigint,
  add column if not exists expected_reimbursements_cents bigint;

comment on column payroll_gl_reports.expected_net_pay_cents is
  'Sum of the journal''s "Check Amount" column: the disbursement ACH Gusto pulls. NOT gross wages -- it is net of withholding and inclusive of reimbursements. NULL for reports parsed before amount matching existed.';
comment on column payroll_gl_reports.expected_tax_cents is
  'Sum of "Employee Taxes" + "Employer Taxes": the tax-remittance ACH. NULL for reports parsed before amount matching existed.';
comment on column payroll_gl_reports.expected_reimbursements_cents is
  'Sum of "Reimbursements". Already included in expected_net_pay_cents; stored separately because reimbursements move cash without being wage expense, so they appear in no GL bucket. This is the term that reconciles the two debits against the report''s GL total -- without it that difference reads as an unexplained variance.';

-- ── Who matched, and against what ───────────────────────────────────────────
-- matched_by was NOT NULL references auth.users(id), which encoded an
-- assumption that is no longer true: a match is now a consequence of the bank
-- sync noticing a charge equal to an expected debit, and no human is present
-- when that happens. Nullable means "nobody chose this, the amounts agreed" --
-- which is a fact worth being able to distinguish from a person's decision,
-- not a gap to paper over with a sentinel user id.
alter table payroll_period_expense_matches
  alter column matched_by drop not null;

-- Which of the two debits this charge satisfied. NULL covers both the manual
-- "Match payroll period" action and every row written before this migration,
-- neither of which was matched against a component.
alter table payroll_period_expense_matches
  add column if not exists matched_component text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'payroll_period_expense_matches_matched_component_check'
  ) then
    alter table payroll_period_expense_matches
      add constraint payroll_period_expense_matches_matched_component_check
      check (matched_component is null or matched_component in ('net_pay', 'taxes'));
  end if;
end $$;

comment on column payroll_period_expense_matches.matched_by is
  'The user who matched this expense by hand. NULL when the bank sync matched it automatically because its amount equalled one of the report''s expected debits.';
comment on column payroll_period_expense_matches.matched_component is
  'Which expected debit this charge satisfied: net_pay or taxes. NULL for hand-matched rows and for rows predating amount matching.';

-- A period's two debits are distinct, so the same component must not be claimed
-- twice -- a second charge matching net_pay means something is wrong (a
-- duplicate debit, a re-run) and should surface rather than silently double the
-- period's matched cash. Partial, so the unconstrained NULLs above are unaffected.
create unique index if not exists payroll_period_expense_matches_period_component_uniq
  on payroll_period_expense_matches (pay_period_id, matched_component)
  where matched_component is not null;
