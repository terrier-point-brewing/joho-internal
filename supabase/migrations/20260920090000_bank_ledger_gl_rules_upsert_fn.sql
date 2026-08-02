-- supabase/migrations/20260920090000_bank_ledger_gl_rules_upsert_fn.sql
--
-- Repairs the Bank Feeds and Counterparties switches under Settings > Finance
-- > GL Mapping, which have never been able to save a decision.
--
-- SYMPTOM: toggling "Counts towards the books" for any bank feed (Chase,
-- Ramp) or any counterparty returns "Could not save that change." from
-- app/api/finance/bank-ledger-rules/route.ts, every time, for every row.
-- select count(*) from bank_ledger_gl_rules in production is 0 -- no
-- decision has ever been recorded there, which is also why every feed reads
-- "not set" regardless of whether it is actually posting: that label reflects
-- whether a rule row exists, not the feed's current include_in_gl state.
--
-- CAUSE: the PUT handler calls supabase-js .upsert(row, { onConflict }),
-- which PostgREST turns into a plain `insert ... on conflict (source) do
-- update ...` (or `(source, counterparty_key)` for a counterparty rule).
-- Both of this table's unique indexes (20260917090000_bank_ledger_gl_rules.sql)
-- are PARTIAL -- `where scope = 'source'` and `where scope = 'counterparty'`
-- -- deliberately, so a source-scoped rule and a counterparty-scoped rule can
-- never collide. Postgres only accepts a partial index as an ON CONFLICT
-- arbiter when the statement supplies a WHERE clause matching that index's
-- predicate, and PostgREST's upsert has no way to add one. So the INSERT
-- fails to resolve an arbiter at planning time -- 42P10, "there is no unique
-- or exclusion constraint matching the ON CONFLICT specification" -- whether
-- or not a conflicting row actually exists. This has been broken since the
-- table was introduced.
--
-- FIX: move the write behind a function that spells out the matching WHERE
-- on each arm's own ON CONFLICT, and have the route call it with .rpc()
-- instead of .upsert(). Table shape and both partial indexes are unchanged.

create or replace function public.upsert_bank_ledger_gl_rule(
  p_scope             text,
  p_source             text,
  p_counterparty_key   text,
  p_counterparty_label text,
  p_included           boolean
)
returns public.bank_ledger_gl_rules
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.bank_ledger_gl_rules;
begin
  if p_scope = 'source' then
    insert into public.bank_ledger_gl_rules (scope, source, counterparty_key, counterparty_label, included)
    values ('source', p_source, null, p_counterparty_label, p_included)
    on conflict (source) where scope = 'source'
    do update set
      included           = excluded.included,
      counterparty_label = excluded.counterparty_label
    returning * into result;
  elsif p_scope = 'counterparty' then
    if p_counterparty_key is null then
      raise exception 'counterparty_key required for scope=counterparty';
    end if;
    insert into public.bank_ledger_gl_rules (scope, source, counterparty_key, counterparty_label, included)
    values ('counterparty', p_source, p_counterparty_key, p_counterparty_label, p_included)
    on conflict (source, counterparty_key) where scope = 'counterparty'
    do update set
      included           = excluded.included,
      counterparty_label = excluded.counterparty_label
    returning * into result;
  else
    raise exception 'scope must be source or counterparty, got %', p_scope;
  end if;

  return result;
end;
$$;

comment on function public.upsert_bank_ledger_gl_rule(text, text, text, text, boolean) is
  'Records one Bank Feeds / Counterparties decision. Exists only because both of bank_ledger_gl_rules'' unique indexes are partial, which PostgREST''s upsert cannot target -- see this migration''s header.';

-- Same posture as every other internal SECURITY DEFINER function here
-- (20260709_security_advisor_hardening.sql): not reachable via the Data API
-- by anon or authenticated, only by the admin route through service_role.
revoke execute on function public.upsert_bank_ledger_gl_rule(text, text, text, text, boolean) from public, anon, authenticated;
grant  execute on function public.upsert_bank_ledger_gl_rule(text, text, text, text, boolean) to service_role;
