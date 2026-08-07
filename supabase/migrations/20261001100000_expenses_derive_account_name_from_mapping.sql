-- Stop storing a copy of the source account's name and code on `expenses`.
--
-- Both describe the ACCOUNT, not the transaction. The account already has a row
-- of its own in expense_account_mappings, keyed UNIQUE (source,
-- external_account_id) -- so `expenses` keeps external_account_id and readers
-- derive the name through that key (app/api/finance/expenses/route.ts).
--
-- The two columns are NOT the same kind of duplicate, and the difference is
-- worth recording because it is the opposite of what it looks like:
--
--   external_account_name  A true copy. All 236 rows with a non-null
--                          external_account_id matched their mapping row
--                          exactly -- zero drift -- so deriving it changes
--                          nothing anyone can see. Guarded below.
--
--   external_account_code  NOT a copy. It holds a different value from the
--                          mapping's column of the same name: `expenses` has
--                          the chart-of-accounts number ('5110', '6310'), the
--                          mapping has Ramp's own account id ('1150040025',
--                          '68'). They agree on only 48 of 236 rows, and only
--                          where the two numbering schemes happen to collide.
--                          The mapping's copy is the stale one: it is written
--                          once when an account is first seen, while `expenses`
--                          was rewritten on every sync. So this column is NOT
--                          derived -- it is dropped as dead. Nothing reads it:
--                          the API selected it and the page typed it, but no
--                          code path ever rendered or branched on it. The value
--                          the sync actually needs is the one on the in-memory
--                          record, which feeds matchAccountToCoa and the
--                          mapping upsert -- neither of which touches this
--                          column.
--
-- Statement totals cannot move: lib/finance/financials/fetchSources.ts reads
-- only id, chart_of_accounts_id, amount_cents, accounting_date, mapping_source
-- and state from this table. Verified byte-identical P&L / balance sheet /
-- cash flow either side of this change regardless.

-- ── Guard 1: the name must be derivable for every row that has an account ────
DO $$
DECLARE
  drifted bigint;
BEGIN
  SELECT count(*) INTO drifted
  FROM public.expenses e
  LEFT JOIN public.expense_account_mappings m
    ON m.source = e.source
   AND m.external_account_id = e.external_account_id
  WHERE e.external_account_id IS NOT NULL
    AND e.external_account_name IS DISTINCT FROM m.external_account_name;

  IF drifted > 0 THEN
    RAISE EXCEPTION
      'Refusing to drop expenses.external_account_name: % row(s) have no mapping row, or one whose name differs',
      drifted;
  END IF;
END $$;

-- ── Guard 2: nothing orphaned on the rows that have no account ───────────────
-- 35 rows carry no external_account_id (Ramp bank lines and uncoded bills).
-- If any of them held a name or code there would be nothing to derive it from,
-- and dropping the column would destroy the only copy.
DO $$
DECLARE
  orphaned bigint;
BEGIN
  SELECT count(*) INTO orphaned
  FROM public.expenses
  WHERE external_account_id IS NULL
    AND (external_account_name IS NOT NULL OR external_account_code IS NOT NULL);

  IF orphaned > 0 THEN
    RAISE EXCEPTION
      'Refusing to drop: % row(s) carry an account name/code but no external_account_id to derive it from',
      orphaned;
  END IF;
END $$;

-- Deliberately no CASCADE: if a view or index turns out to depend on either
-- column, fail loudly rather than quietly drop the dependent object too.
ALTER TABLE public.expenses DROP COLUMN IF EXISTS external_account_name;
ALTER TABLE public.expenses DROP COLUMN IF EXISTS external_account_code;
