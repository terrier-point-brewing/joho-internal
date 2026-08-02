-- Counterparty routing becomes an application registry rather than a DB enum.
--
-- `expense_counterparty_mappings.routing` was pinned by a check constraint to
-- ('single_account', 'payroll_split') — see 20260714_payroll_gl_split.sql. Two
-- values was tolerable. The balance-sheet method layer
-- (lib/finance/balances/methods/definitions.ts) adds accounts continuously, and
-- some of those accounts account for bank lines by counterparty, so the value
-- set only grows. Under a check constraint every one of those costs a migration
-- plus five code edits, and the settings screen's dropdown turns into a menu of
-- feature names an operator has to learn.
--
-- The modes live in lib/finance/counterpartyHandlers.ts instead, and the PATCH
-- route validates against that registry (isSelectableHandler) before writing.
-- This is the same arrangement balance_sheet_account_sources.provider_key
-- already has: free text in the column, a registry in the app, and no DDL when
-- a new one is added.
--
-- ── Why dropping this constraint does not widen anything ─────────────────────
-- The column was never operator-writable. Its only writer is the PATCH handler
-- in app/api/finance/expense-counterparty-mappings, which now refuses any value
-- the registry does not list AND refuses any value that is claim-only (derived
-- from a balance-sheet method's setup, never chosen by hand). So the set of
-- values that can reach this column gets SMALLER at this commit, not larger:
-- 'balance_sheet' exists as a handler but cannot be written through the API.
--
-- No data change. Every existing row holds 'single_account' or 'payroll_split',
-- both of which remain valid registry keys with unchanged behaviour.

alter table public.expense_counterparty_mappings
  drop constraint if exists expense_counterparty_mappings_routing_check;

comment on column public.expense_counterparty_mappings.routing is
  'Which handler codes this counterparty. Validated against COUNTERPARTY_HANDLERS in lib/finance/counterpartyHandlers.ts, not by a check constraint — see 20260921090000. Only handlers whose glEffect is ''account'' code the expense from chart_of_accounts_id; every other value means something else codes it and resolveExpenseMapping leaves the expense unmapped.';
