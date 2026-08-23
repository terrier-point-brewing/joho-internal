-- Bank ledger flow types: make the vocabulary match what the reports actually do.
--
-- Three problems with the six values this replaces:
--
--   * `operating_expense` was absent. It exists in the application's FlowType
--     union only as Ramp's routing signal -- a Ramp line classified that way is
--     diverted into `expenses` and never written here -- so the constraint never
--     needed it. Plaid has no such diversion: every Chase row lands in this
--     table, which left a plain vendor debit with no reachable correct value.
--
--   * `interest_income` was the only value the P&L reader counted, and it is too
--     narrow a name for the thing it has to cover (a rebate, a refunded expense,
--     an insurance recovery). Renamed to `other_income`.
--
--   * `deposit` was used for the Ramp side of a Chase -> Ramp wallet funding,
--     while the Chase side of the SAME movement is an internal transfer. One
--     movement described two ways, with the own-account half sitting in the
--     group that means "already recorded elsewhere".
--
-- `balance_sheet_movement` is new and has no existing rows: it is the value for
-- money that moved but is neither income nor expense and is not settling
-- anything -- a loan draw, an owner contribution, a payment against an accrued
-- liability such as GL 2220.
--
-- Rows coded by hand are not touched by the reclassifications below. A person's
-- decision is not ours to reinterpret, and `interest_income` -> `other_income`
-- is a pure rename that applies to them anyway.

begin;

alter table public.bank_ledger drop constraint if exists bank_ledger_flow_type_check;

-- Rename. Same meaning, wider name; safe for manual rows.
update public.bank_ledger
   set flow_type = 'other_income'
 where flow_type = 'interest_income';

-- Ramp's wallet-funding deposits. Scoped to source='ramp' AND the description
-- the classifier assigns, so this cannot catch a genuine customer deposit that
-- someone coded by hand.
update public.bank_ledger
   set flow_type = 'internal_transfer'
 where flow_type = 'deposit'
   and source    = 'ramp'
   and description = 'Deposit'
   and mapping_source <> 'manual';

alter table public.bank_ledger
  add constraint bank_ledger_flow_type_check
  check (flow_type = any (array[
    'operating_expense',
    'other_income',
    'balance_sheet_movement',
    'card_settlement',
    'bill_settlement',
    'deposit',
    'internal_transfer',
    'unclassified'
  ]::text[]));

-- affects_pl is a cache of the flow type, and the two just moved apart: the
-- application now counts `operating_expense` as well as income. No existing row
-- carries either of the new P&L values, so this is a no-op today and a guard
-- against a row that predates the writers being updated.
update public.bank_ledger
   set affects_pl = (flow_type in ('operating_expense', 'other_income'))
 where affects_pl is distinct from (flow_type in ('operating_expense', 'other_income'));

commit;
