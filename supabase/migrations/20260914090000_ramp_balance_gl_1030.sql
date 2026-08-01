-- supabase/migrations/20260914090000_ramp_balance_gl_1030.sql
--
-- Points GL 1030 Ramp Operating Account at the `rampBalance` method
-- (lib/finance/balances/methods/definitions.ts), so the account's monthly
-- balance is read from Ramp instead of being left unsourced.
--
-- ── No schema change ─────────────────────────────────────────────────────────
-- Every table this integration needs already exists:
-- integration_connections from 20260913090000, and
-- balance_sheet_account_sources from the balance-sheet work before it. Ramp
-- needs no row in gl_account_daily_balances either -- its balance-history
-- endpoint answers about the past, so a month end can always be re-asked for.
-- That table is Plaid's, whose endpoint cannot.
--
-- ── This migration cannot change a displayed figure ──────────────────────────
-- GL 1030 has NO balance source today, so there is no existing calculation to
-- displace and no snapshot row to overwrite. The method it gains here resolves
-- its connection through `config.connectionId`, which starts unset, and the
-- provider returns null when it is -- so the account keeps reading exactly as
-- it does now, unsourced, until an operator connects a Ramp account under
-- Settings > Finance > Ramp Connection and links it on Settings > Finance >
-- Balance Sheet Accounts.
--
-- What this buys, versus leaving the operator to add the method by hand: the
-- connection picker only renders on a source whose method declares a
-- connection, so seeding the row is what makes the account linkable at all
-- without first hunting through a dropdown.
--
-- ── Safe in either deploy order ──────────────────────────────────────────────
--   * migration first -> `rampBalance` is unknown to the running code, which
--     reports the account and skips it. Nothing is written; GL 1030 stays
--     unsourced, which is what it already was.
--   * code first -> the method is registered and simply has no account using
--     it until this lands.
-- Neither ordering has a window where a wrong figure renders.
--
-- The connection row itself is deliberately NOT seeded here. It needs the Ramp
-- treasury account's id, which only Ramp can supply, and inventing a
-- half-configured row would put "Ramp · (unset)" in the picker for an operator
-- to link to nothing.

do $$
declare
  v_coa_id  uuid;
  v_matches bigint;
begin
  -- Resolve by account_number, failing loudly on zero or multiple matches
  -- rather than silently skipping, matching 20260912110000's pattern. 4999 is a
  -- known duplicate in this chart of accounts, so resolve-by-number is only
  -- safe for a number verified to be unique -- 1030 is.
  select count(*) into v_matches
    from public.chart_of_accounts
   where account_number = '1030';

  if v_matches <> 1 then
    raise exception
      'ramp balance: account_number 1030 matches % chart_of_accounts rows, expected exactly 1', v_matches;
  end if;

  select id into v_coa_id
    from public.chart_of_accounts
   where account_number = '1030';

  -- Idempotent, and non-destructive on re-run: an operator who has already
  -- linked a connection has it in `config`, and do-nothing preserves that.
  insert into public.balance_sheet_account_sources (chart_of_accounts_id, provider_key, config, active)
  values (v_coa_id, 'rampBalance', '{}'::jsonb, true)
  on conflict (chart_of_accounts_id, provider_key) do nothing;

  raise notice 'ramp balance: GL 1030 sourced from the Ramp account balance method';
end $$;
