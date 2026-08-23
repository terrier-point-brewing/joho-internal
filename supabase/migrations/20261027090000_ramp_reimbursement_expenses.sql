-- Out-of-pocket reimbursement claims become expense rows, and the bank debit
-- that pays them stops being one.
--
-- ── What was wrong ───────────────────────────────────────────────────────────
-- An employee spends their own money; Ramp pays them back in an ACH debit that
-- may cover several claims at once. Nothing read the claims -- lib/ramp.ts has
-- requested the `reimbursements:read` scope since the integration was written
-- but never called the endpoint -- so the payout debit on the Chase feed was the
-- only trace of the spend anywhere in the books.
--
-- That forces two errors. The spend is dated to whenever the employee happened
-- to get paid rather than when it was incurred, and one GL account is forced
-- onto a batch of unrelated purchases. The $704.85 debit of 2026-06-23 settles a
-- $540 claim and a $164.85 one; no single account is right for it.
--
-- ── The double count this closes at the same time ────────────────────────────
-- Importing the claims makes the payout a SETTLEMENT. Left classified as an
-- operating expense it would now be the second booking of the same money, so
-- this migration sets the "Ramp Reimbursement" counterparty rule to
-- `bill_settlement` in the same transaction that makes the claims importable.
--
-- Writing an operator's rule from a migration is not something to do lightly.
-- It is done here because the risk is created by this change and did not exist
-- before it, so leaving the rule to a later human decision would mean shipping a
-- known double count and hoping. The rule is an ordinary row and can be changed
-- in Settings -> Finance -> GL Mapping -> Counterparties like any other.
--
-- The evidence that the payout really is a settlement is exact rather than
-- inferred: Chase prints Ramp's payout id verbatim in the ACH descriptor's
-- CO ENTRY DESCR field, and every one of the five Chase debits matches a Ramp
-- payment_id --
--
--     CRBWEJU64Q -> Wake ABC              $84.80
--     9FWJCMZT33 -> Wake Co Bureau        $35.00
--     PVY4NMRKTF -> Apple                 $42.85
--     VCZW7YFW2K -> $540.00 + $164.85 = $704.85   (one payout, two claims)
--     DGZGDHCWG7 -> Undercover Band      $400.00
--
-- -- and the six claims total $1,267.50, which is the Chase total to the cent.
--
-- Only the Chase feed is affected. Ramp's own bank feed has never carried these
-- payouts.

begin;

alter table public.expenses drop constraint if exists expenses_ramp_object_check;

alter table public.expenses
  add constraint expenses_ramp_object_check
  check (ramp_object = any (array['card', 'bill', 'bank', 'reimbursement']::text[]));

comment on column public.expenses.ramp_object is
  'Which Ramp resource this row came from. ''reimbursement'' is an out-of-pocket claim: a peer of ''bill'' rather than of ''bank'', because both are incurred on one date and settled on another, and the bank debit that settles either must never be booked as the expense a second time.';

-- The rule that stops the payout being counted twice. Scoped to the Chase feed
-- and to the counterparty bankDescriptor.ts derives from `ORIG CO NAME:RMPR …`
-- (normalizeCounterparty lower-cases and collapses whitespace, so the key is
-- 'ramp reimbursement').
--
-- Inserted rather than updated, because a rule row is only created the moment
-- somebody first assigns something to a counterparty -- a counterparty seen only
-- in the bank ledger is listed on the settings screen with a null id and has no
-- row yet. This one has none, so an UPDATE would match nothing and the double
-- count would ship silently.
--
-- The conflict clause only ever fills a NULL: if somebody has already taken a
-- view on this counterparty, theirs stands.
insert into public.expense_counterparty_mappings (source, counterparty_key, counterparty_label, flow_type)
values ('plaid', 'ramp reimbursement', 'Ramp Reimbursement', 'bill_settlement')
on conflict (source, counterparty_key) do update
   set flow_type = excluded.flow_type
 where public.expense_counterparty_mappings.flow_type is null;

-- The rows the old rule already classified.
--
-- Setting the rule is not enough on its own: resolveBankBackfill only ever
-- FILLS a flow, never revises one, so five payouts already carrying
-- `operating_expense` from the previous rule would sit there being counted a
-- second time while the rule above quietly said otherwise.
--
-- Restricted to `mapping_source = 'rule'`, which is the whole basis for touching
-- them: those rows are owned by a rule and were never anybody's decision. A row
-- somebody coded by hand is left exactly as it is, even if it is one of these
-- five -- the same line every resolver in this codebase declines to cross.
--
-- The account goes with the flow. A settlement carries none, and the balance
-- sheet reader matches on the account without ever looking at the flow, so one
-- left behind would go on moving a reported balance.
update public.bank_ledger
   set flow_type            = 'bill_settlement',
       affects_pl           = false,
       chart_of_accounts_id = null
 where source           = 'plaid'
   and counterparty_name = 'Ramp Reimbursement'
   and flow_type         = 'operating_expense'
   and mapping_source    = 'rule';

commit;
