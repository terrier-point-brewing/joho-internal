-- A grouping account (e.g. "Taproom Liquor Sales") that only ever exists to
-- hold sub-accounts has no balance of its own to source -- its total is
-- already the sum of its children on the real Balance Sheet statement
-- (app/finance/financials/buildTree.ts rolls that up automatically). Without
-- this flag, Settings > Finance > Balance Sheet Accounts and the Financials
-- "Unsourced Accounts" data-quality tile both nag that account forever, the
-- same false-permanent-warning shape 20260919090002_gl_mapping_exclusions.sql
-- already fixed for expense/tax/catalog mappings. This gives chart_of_accounts
-- the same bare `excluded` column, for the same reason.
--
-- Default false: an existing "N of M accounts calculating" count must not
-- change meaning the moment this migration runs. Exclusion is something a
-- person opts an account into from here on, never a fact this migration infers.

alter table public.chart_of_accounts
  add column if not exists excluded boolean not null default false;

comment on column public.chart_of_accounts.excluded is
  'True for a grouping account whose balance should come only from summing its sub-accounts (chart_of_accounts.parent_id) -- never sourced or manually entered on its own. Lets Settings > Finance > Balance Sheet Accounts and the Financials "Unsourced Accounts" data-quality tile stop treating a deliberate rollup account as a permanent outstanding setup gap.';
