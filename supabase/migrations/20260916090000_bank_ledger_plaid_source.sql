-- supabase/migrations/20260916090000_bank_ledger_plaid_source.sql
--
-- Chase transactions from Plaid, in the SHARED bank ledger, and the columns that
-- let a Square month-end difference be split into "swept to the bank" and
-- "genuinely unexplained".
--
-- ── One ledger, discriminated by source ──────────────────────────────────────
-- ramp_bank_ledger already carried `source` and `source_transaction_id` and a
-- unique constraint across the pair, so it was half-generalised from the start.
-- This extends it to carry a second source rather than standing up a parallel
-- table. The name stays: ten modules read it, one of them under the verified
-- P&L, and a rename would have to touch every one of them in the same commit to
-- buy nothing the `source` column does not already give.
--
-- ── The safety property, and how it is enforced ──────────────────────────────
-- Read this before adding a writer or a reader.
--
-- lib/finance/balances/providers/transactionPostings.ts and
-- lib/finance/financials/fetchSources.ts both read this table, and they feed the
-- balance sheet, the profit and loss, the cash-flow statement and the
-- transactions grid — all verified and in production use. A Chase row appearing
-- in that aggregation would silently change reported figures for every month the
-- import covers, which is up to two years.
--
-- So: `include_in_gl` gates it, and every reader filters on it.
--
--   * The column DEFAULTS TO TRUE, so every row already in this table keeps
--     counting exactly as it did. Applying this migration changes no reported
--     figure anywhere — the readers gain a predicate that every existing row
--     already satisfies.
--   * The Plaid importer writes FALSE explicitly. Chase rows therefore land
--     excluded and stay excluded until a person deliberately opts them in.
--   * Those rows also land with a null chart_of_accounts_id and
--     mapping_source 'unmapped', which is a second, independent barrier: the
--     balance-sheet reader matches on account id and would skip them regardless.
--
-- Whether Chase transactions SHOULD feed the general ledger, and which
-- counterparties map where, is a separate piece of work. This migration builds
-- the switch; it does not throw it.

-- ── 1. A second source ───────────────────────────────────────────────────────
alter table public.ramp_bank_ledger
  drop constraint if exists ramp_bank_ledger_source_check;

alter table public.ramp_bank_ledger
  add constraint ramp_bank_ledger_source_check check (source in ('ramp', 'plaid'));

-- ── 2. The inclusion gate ────────────────────────────────────────────────────
-- Default true so existing rows and existing writers are untouched. A source
-- that should not reach the books sets it false at import.
alter table public.ramp_bank_ledger
  add column if not exists include_in_gl boolean not null default true;

comment on column public.ramp_bank_ledger.include_in_gl is
  'Whether this row reaches the general ledger — the balance sheet, the profit and loss, the cash-flow statement and the transactions grid. Defaults true so pre-existing rows are unaffected. Plaid-sourced rows are imported FALSE and stay out until someone deliberately opts them in.';

-- ── 3. Where a row came from, for a source that has more than one account ────
-- Ramp writes one account's movement and never needed these. A Plaid item can
-- carry a checking and a savings and the sync feed returns both, so a row has to
-- say which account it belongs to or another account's traffic would end up in
-- GL 1020's reconciliation.
alter table public.ramp_bank_ledger
  add column if not exists connection_id       uuid references public.integration_connections(id) on delete set null,
  add column if not exists external_account_id text,
  -- The raw bank descriptor. The Square ACH originator id survives here at
  -- institutions that clean up `description`, and it is the token the sweep
  -- matcher keys on.
  add column if not exists original_description text,
  -- A pending ACH credit may post later under a different id. Stored, but never
  -- reconciled against, because counting both would double the sweep.
  add column if not exists pending             boolean not null default false,
  -- The whole provider payload. A field nobody thought to type cannot be
  -- recovered by re-syncing, because a cursor feed replays changes and not
  -- history that was discarded at import.
  add column if not exists raw                 jsonb;

comment on column public.ramp_bank_ledger.external_account_id is
  'The account identifier at the source, for a provider whose feed spans several accounts (Plaid). Null for Ramp, which writes one account.';
comment on column public.ramp_bank_ledger.original_description is
  'The unmodified bank descriptor. Square ACH credits carry ORIG ID:9424300002 here at institutions that clean up the description field.';

-- The reconciliation reads one bank account over one month.
create index if not exists idx_ramp_bank_ledger_source_account
  on public.ramp_bank_ledger (source, external_account_id, transaction_date);

-- Every general-ledger reader now filters on include_in_gl, and all but a
-- handful of rows satisfy it, so the useful index is the partial one over the
-- exceptions the readers must skip.
create index if not exists idx_ramp_bank_ledger_excluded
  on public.ramp_bank_ledger (transaction_date)
  where include_in_gl = false;

-- ── 4. The Square drift split ────────────────────────────────────────────────
-- square_balance_reconciliations records what re-anchoring absorbed each month.
-- Until now that was one undifferentiated figure, because the outflow from the
-- Square balance was observable nowhere. With a Chase feed it can be split.
--
-- Every one of these is NULLABLE and that is the point. NULL means "the bank
-- account for this period had no transactions to check", which is a completely
-- different statement from "nothing was swept". A missing feed writing a zero
-- would turn an absence of evidence into a confident finding, on a row whose
-- entire purpose is to be honest about what is not known.
alter table public.square_balance_reconciliations
  add column if not exists swept_exact_cents     bigint,
  add column if not exists swept_name_only_cents bigint,
  add column if not exists swept_match_count     integer,
  add column if not exists unexplained_cents     bigint;

comment on column public.square_balance_reconciliations.swept_exact_cents is
  'Deposits into the declared bank account matching Square ACH originator id 9424300002. NULL when that account had no transactions for the period — which is not the same as zero swept.';
comment on column public.square_balance_reconciliations.swept_name_only_cents is
  'Deposits matched on the originator NAME alone, which is prose and weaker evidence. Kept apart from the exact figure rather than summed into it.';
comment on column public.square_balance_reconciliations.unexplained_cents is
  'drift_cents plus everything matched as a Square sweep. Zero means the month reconciles. NULL when there was no bank feed to check against.';

-- ── 5. coa_reference_count ───────────────────────────────────────────────────
-- Unchanged, deliberately. ramp_bank_ledger is already counted there as 'bank
-- ledger lines', and Plaid rows carry a null chart_of_accounts_id, so they
-- reference no account and there is nothing new to protect.
