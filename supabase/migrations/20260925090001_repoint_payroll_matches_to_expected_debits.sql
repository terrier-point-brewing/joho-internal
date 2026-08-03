-- Re-derive the existing payroll matches against the expected debits.
--
-- ⚠ PARTIALLY APPLIED IN PRODUCTION as of 2026-08-03.
-- The two UPDATE statements (step 1, labelling) ran as the migration
-- `label_payroll_matches_with_expected_debit_component`. The two DELETEs
-- (step 2) have NOT run: they remove production rows and need a human to
-- authorise them. Everything here is idempotent, so re-running the whole file
-- is safe -- the UPDATEs will simply re-set the values they already set.
-- Until step 2 runs, the five non-payroll charges stay matched and keep being
-- booked to wage/tax accounts; the ledger shows them as "· split (N)" rather
-- than "· net pay"/"· taxes", which is the visible tell.
--
-- 20260925090000 gave every report the two ACH amounts Gusto actually pulls,
-- and taught the matcher to use them. It could not fix the rows already in
-- payroll_period_expense_matches: those were written by the old nearest-date
-- rule, and the matcher deliberately refuses to touch a charge another match
-- already claims. So without this, the historical mis-matches stay forever and
-- amount matching only ever applies to future periods.
--
-- Two things happen here, both keyed off amounts the database now knows:
--
--   1. A matched charge equal to its period's net-pay or tax pull is KEPT and
--      labelled with the component it satisfies. Nothing about it changes
--      except that the row can now say what it is.
--
--   2. A matched charge equal to NEITHER is deleted, because a payroll-routed
--      counterparty billing something that is not one of the period's two pulls
--      is, by construction, not payroll. Its payroll_auto splits go with it --
--      those splits are the mechanism by which it was being booked to wage and
--      tax accounts in the P&L, which is the actual harm being undone. The
--      expense itself is untouched: it returns to the ledger unmapped, where an
--      operator codes it to whatever it really was.
--
-- Five charges are removed by (2) -- $655.92 and $137.16 from Jun 1-14, $350.93
-- and $67.64 from Jun 15-28, $150.39 from Jun 29-Jul 12 -- totalling $1,362.04
-- that was being reported as payroll and is not. The two $131.09 Gusto software
-- subscription charges are NOT here: they were already unmatched and pinned to
-- 6130 by hand, and this migration cannot reach a charge that has no match row.
--
-- Splits for the surviving matches are NOT recomputed here. Removing a charge
-- changes the proportional weight of every other charge in its period, so each
-- affected period needs recomputePeriodExpenseSplits -- which is TypeScript
-- (it reads the report's GL buckets and re-allocates), not expressible as DDL.
-- Run it per period afterwards via
-- POST /api/finance/payroll-periods/{periodId}/recompute-splits.

-- The active report per period, i.e. the one whose amounts are authoritative.
create temporary table _active_expected on commit drop as
select distinct on (r.pay_period_id)
       r.pay_period_id, r.expected_net_pay_cents, r.expected_tax_cents
from payroll_gl_reports r
where r.superseded_at is null
  and r.expected_net_pay_cents is not null
  and r.expected_tax_cents is not null
order by r.pay_period_id, r.uploaded_at desc;

-- (1) Label the charges that ARE one of the period's two pulls.
--
-- Written as one statement per component rather than a CASE so that the partial
-- unique index on (pay_period_id, matched_component) is what enforces "one
-- net_pay per period" -- if two charges in a period somehow share the net-pay
-- amount, this fails loudly instead of silently labelling both.
update payroll_period_expense_matches m
set matched_component = 'net_pay'
from _active_expected a, expenses e
where a.pay_period_id = m.pay_period_id
  and e.id = m.expense_id
  and abs(e.amount_cents) = a.expected_net_pay_cents;

update payroll_period_expense_matches m
set matched_component = 'taxes'
from _active_expected a, expenses e
where a.pay_period_id = m.pay_period_id
  and e.id = m.expense_id
  and abs(e.amount_cents) = a.expected_tax_cents
  and m.matched_component is null;  -- never re-label a row (1) already claimed

-- (2) Drop the charges that are neither, and the GL splits that were booking
--     them as payroll. Scoped to periods that HAVE expected amounts: a period
--     whose report predates them keeps its old matches untouched, because
--     nothing here knows enough to judge them.
delete from expense_gl_splits s
where s.split_source = 'payroll_auto'
  and s.expense_id in (
    select m.expense_id
    from payroll_period_expense_matches m
    join _active_expected a on a.pay_period_id = m.pay_period_id
    where m.matched_component is null
  );

delete from payroll_period_expense_matches m
using _active_expected a
where a.pay_period_id = m.pay_period_id
  and m.matched_component is null;
