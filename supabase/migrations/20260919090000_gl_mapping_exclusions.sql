-- An operator can now say "this source account/tax/variation will never get a
-- GL account, on purpose" instead of GL Mapping's coverage count treating that
-- silence as an open item forever.
--
-- Counterparties and bank feeds already have this move — switching one "out of
-- the books" (bank_ledger_gl_rules.included = false) means it stops needing an
-- account and GL Mapping's summary already reads that table when computing its
-- count. This migration gives the three flat-table mapping panels the same
-- option, as a column on the row itself rather than a side table: unlike a
-- counterparty or a feed, a Ramp GL account, a Square tax or a catalog
-- variation cannot be "seen" without already having a row that names it, so
-- there is no need for a rule that outlives the row it describes.
--
-- Default false everywhere: an existing "N of M mapped" count must not change
-- meaning the moment this migration runs. Exclusion is something a person
-- opts a row into from here on, never a fact this migration infers.

alter table public.expense_account_mappings
  add column if not exists excluded boolean not null default false;

comment on column public.expense_account_mappings.excluded is
  'True when a person decided this source account never gets a blanket GL rule (e.g. a catch-all account whose expenses are coded line by line). Excluded rows drop out of the "N of M mapped" denominator on Settings > GL Mapping > Expenses instead of sitting there as a permanent false warning.';

alter table public.square_tax_accounts
  add column if not exists excluded boolean not null default false;

comment on column public.square_tax_accounts.excluded is
  'True when a person decided this Square tax never gets a liability account (e.g. a $0/test tax with no real collections). Excluded rows drop out of the "N of M mapped" denominator on Settings > GL Mapping > Sales Tax instead of sitting there as a permanent false warning.';

alter table public.square_catalog_variations
  add column if not exists excluded boolean not null default false;

comment on column public.square_catalog_variations.excluded is
  'True when a person decided this variation never gets a GL account (e.g. a $0 placeholder or a discontinued test item). Excluded variations count as resolved in every GL Mapping > Revenue coverage count and are skipped by the bulk "Fill unmapped" / "Overwrite all" mappers, the same way a manually-pinned expense survives a rule cascade.';
