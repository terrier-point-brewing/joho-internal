-- ============================================================================
-- An uncoded reimbursement claim is keyed by its merchant.
--
-- A Ramp card swipe reaches the chart of accounts through the category the
-- employee picked in Ramp, which lands on `expenses.external_account_id` and
-- resolves through GL Mapping -> Expense Accounts. An out-of-pocket CLAIM,
-- filed from a phone in a car park, routinely carries no category at all: six
-- of the first seven had none. Nothing in this system could then code those
-- claims but a person, one row at a time, forever -- the $14.15 of ice bought
-- for the taproom on 2026-08-22 being the case that prompted this.
--
-- The merchant is the one fact such a claim always carries, and `merchant_name`
-- on a claim is already where the money WENT ("Wake ABC") rather than who
-- fronted it -- the employee is the card holder. That is exactly what a GL rule
-- keys on. So an uncoded claim now carries a `counterparty_key`, which is what
-- puts its merchant on Settings -> Finance -> GL Mapping -> Counterparties,
-- where one standing answer codes every future claim at that merchant.
--
-- The adapter does this from now on (lib/finance/rampExpenses.ts). This file is
-- the same rule applied to the claims already imported, and the rule rows the
-- Ramp sync would only seed for claims inside its current window.
--
-- ── Only the UNCODED, and that is not an optimisation ────────────────────────
-- `external_account_id` outranks a counterparty rule in resolveExpenseMapping,
-- so keying a coded claim would change no coding. What it would change is the
-- Counterparties screen: every one-off merchant anyone has ever been reimbursed
-- for -- a band booked once for an anniversary party -- would land there as a
-- permanent row asking for an account it does not need. That screen is a list
-- of decisions still owed, and a claim Ramp already coded is not one of them.
--
-- ── NO ACCOUNT IS ASSIGNED, AND NO EXPENSE IS RECODED ───────────────────────
-- This writes a KEY and a rule row with a null account. Which account a
-- merchant codes to is a bookkeeping decision and stays a human's: assigning
-- one here would be this file guessing that ice from a supermarket is taproom
-- supplies rather than an event cost. Every touched row keeps
-- `mapping_source = 'unmapped'` and `chart_of_accounts_id = null`; the moment
-- someone answers on the Counterparties screen, that route's own cascade codes
-- these rows.
--
-- Nor does it touch the settlement side. The Chase payouts that pay these
-- claims are already covered by the standing "Ramp Reimbursement" rule
-- (bill_settlement -- already recorded elsewhere), which is what keeps the
-- claim and its payout from being counted as the same money twice.
--
-- Re-runnable end to end: the update is guarded on the key still being null,
-- and the insert conflicts onto the existing rule.
-- ============================================================================

-- ─── 1. Key the claims that have no coding of their own ─────────────────────
--
-- The normalization must match normalizeCounterparty() in lib/ramp.ts exactly
-- (trim, lower-case, collapse internal whitespace) or a key written here would
-- be a second, unreachable rule beside the one the adapter writes tomorrow.
update public.expenses
   set counterparty_key   = lower(regexp_replace(btrim(merchant_name), '\s+', ' ', 'g')),
       counterparty_label = btrim(merchant_name)
 where source              = 'ramp'
   and ramp_object         = 'reimbursement'
   and external_account_id is null
   and counterparty_key    is null
   and btrim(coalesce(merchant_name, '')) <> '';

-- ─── 2. Seed a rule row for every key that produced ─────────────────────────
--
-- Without this the key would be a dead letter for these rows: the Counterparties
-- screen lists the rule table unioned with the bank ledger, not `expenses`, and
-- the Ramp sync seeds a rule only for claims inside the batch it just pulled --
-- which will never again include a claim from May.
--
-- `routing` defaults to 'single_account' (the account is chosen on this screen)
-- and `auto_matched` is false: a merchant name is not a chart-of-accounts name,
-- so nothing was matched, and claiming otherwise would dress a blank row up as
-- a decision already made. `updated_at` is left to the one trigger that owns it.
insert into public.expense_counterparty_mappings
  (source, counterparty_key, counterparty_label, chart_of_accounts_id, auto_matched)
select 'ramp', e.counterparty_key, min(e.counterparty_label), null, false
  from public.expenses e
 where e.source           = 'ramp'
   and e.ramp_object      = 'reimbursement'
   and e.counterparty_key is not null
 group by e.counterparty_key
on conflict (source, counterparty_key) do nothing;
