-- supabase/migrations/20260912090000_balance_methods.sql
--
-- Collapses the composite balance-sheet accounts from a PAIR of provider rows
-- into a SINGLE method row, so the Settings dropdown offers one complete
-- choice per account rather than two separable halves.
--
-- Why: selecting an accrual without its settling postings produces a wrong
-- balance with no error. GL 2310 shipped in exactly that state and reported
-- -577,257 instead of -72,397 -- tips collected since inception, with the
-- disbursements that settle them missing. The same trap sits under 2220 (tax
-- charged vs tax paid) and 1100 (open invoices vs direct postings). A method is
-- the whole thing; half of one is no longer reachable from the UI.
--
-- ── This migration changes NO computed value ─────────────────────────────────
-- A method's steps are the very providers being replaced, summed the same way,
-- and each step stores its contribution under the SAME key the provider used.
-- gl_account_balances is not touched: existing rows stay valid and readable,
-- and the next snapshot run recomputes the open month to identical figures.
-- Verified by lib/finance/balances/expandSources.test.ts, which asserts the
-- pre- and post-migration source shapes produce byte-identical writes, and
-- against lib/finance/balances/__fixtures__/goldenBalanceSheet.ts.
--
-- ── Safe in either deploy order ──────────────────────────────────────────────
-- expandSources resolves a source key as a method first and falls back to the
-- provider registry, so:
--   * migration applied before the code ships -> "salesTaxPayable" is unknown
--     to the old code, which reports the account and skips it. The previous
--     snapshot row remains; nothing is overwritten with a partial.
--   * code shipped before the migration -> the old provider pairs still resolve
--     through the fallback and produce the same numbers.
-- Neither ordering has a window where the balance sheet renders a wrong figure.
-- Applying it promptly after deploy is still preferable, since the first
-- ordering leaves the four accounts un-recomputed until it lands.
--
-- The five single-provider accounts (2230, 2420, 2430, 1310, 3300) are
-- deliberately NOT touched: their method keys were chosen to equal the provider
-- keys already stored, so they resolve as methods with no data change at all.

do $$
declare
  v_pair    record;
  v_coa_id  uuid;
  v_matches bigint;
  v_n       bigint;
  v_updated bigint := 0;
  v_removed bigint := 0;
begin
  -- (account_number, the two provider rows to collapse, the method replacing them)
  for v_pair in
    select * from (values
      ('2220', 'taxAccrual',    'transactionPostings', 'salesTaxPayable'),
      ('2250', 'taxAccrual',    'transactionPostings', 'salesTaxPayable'),
      ('2310', 'tipAccrual',    'transactionPostings', 'undistributedTips'),
      ('1100', 'openInvoiceAr', 'transactionPostings', 'accountsReceivable')
    ) as t(account_number, primary_key, companion_key, method_key)
  loop
    -- Resolve by account_number, failing loudly on zero or multiple matches
    -- rather than silently skipping. 4999 is a known duplicate in this chart of
    -- accounts, so resolve-by-number is only safe for the four numbers above.
    select count(*) into v_matches
      from public.chart_of_accounts
     where account_number = v_pair.account_number;

    if v_matches <> 1 then
      raise exception
        'balance methods: account_number % matches % chart_of_accounts rows, expected exactly 1',
        v_pair.account_number, v_matches;
    end if;

    select id into v_coa_id
      from public.chart_of_accounts
     where account_number = v_pair.account_number;

    -- Rename the primary provider row in place, preserving active/config/
    -- updated_by. An UPDATE rather than delete-then-insert keeps the audit
    -- trail continuous and cannot lose an operator's disabled state.
    update public.balance_sheet_account_sources
       set provider_key = v_pair.method_key,
           updated_at   = now()
     where chart_of_accounts_id = v_coa_id
       and provider_key = v_pair.primary_key;
    get diagnostics v_n = row_count;

    if v_n = 0 then
      raise notice 'balance methods: % has no % row; already migrated, skipping',
        v_pair.account_number, v_pair.primary_key;
      continue;
    end if;
    v_updated := v_updated + v_n;

    -- Drop the companion row: it is now a STEP of the method above, and
    -- leaving it would double-count postings into the account's total.
    delete from public.balance_sheet_account_sources
     where chart_of_accounts_id = v_coa_id
       and provider_key = v_pair.companion_key;
    get diagnostics v_n = row_count;
    v_removed := v_removed + v_n;
  end loop;

  raise notice 'balance methods: % account(s) switched to a method, % companion row(s) folded in',
    v_updated, v_removed;
end $$;

comment on column public.balance_sheet_account_sources.provider_key is
  'Matches BalanceMethod.key in lib/finance/balances/methods/registry.ts. Historically a bare BalanceProvider key; expandSources still falls back to the provider registry so pre-method rows keep resolving. Not FK''d -- methods are registered in code, not stored in the DB.';
