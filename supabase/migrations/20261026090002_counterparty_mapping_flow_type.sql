-- A counterparty rule can now say what KIND of movement its lines are, not just
-- which account they code to.
--
-- Until now a rule carried `chart_of_accounts_id` alone, so every Chase line
-- still needed a person to pick a flow type by hand before the account meant
-- anything -- and for the majority of them the answer is a standing fact about
-- the counterparty, not a judgement about the transaction. A Ramp wallet funding
-- is an internal transfer every time; a Square payout settles sales already
-- recorded every time.
--
-- NULL means "no opinion". A rule with no flow codes the account exactly as it
-- did before and leaves the row `unclassified` for review, so adding this column
-- changes nothing until somebody fills one in.
--
-- The CHECK mirrors bank_ledger's deliberately. `routing` on this same table has
-- no constraint (20260921090000 removed it) because its vocabulary is a registry
-- that grows; flow types are a closed set that the P&L, cash-flow and balance
-- sheet readers each branch on, and a value none of them recognise would be
-- stored happily and then quietly counted as nothing.

alter table public.expense_counterparty_mappings
  add column if not exists flow_type text null;

alter table public.expense_counterparty_mappings
  drop constraint if exists expense_counterparty_mappings_flow_type_check;

alter table public.expense_counterparty_mappings
  add constraint expense_counterparty_mappings_flow_type_check
  check (flow_type is null or flow_type = any (array[
    'operating_expense',
    'other_income',
    'balance_sheet_movement',
    'card_settlement',
    'bill_settlement',
    'deposit',
    'internal_transfer'
  ]::text[]));

comment on column public.expense_counterparty_mappings.flow_type is
  'What kind of movement this counterparty''s bank lines are. NULL = no opinion; the row stays unclassified for a human. Never includes ''unclassified'' itself -- a rule that classifies something as needing review is the same as no rule.';
