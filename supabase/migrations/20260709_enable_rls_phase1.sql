-- ============================================================================
-- Phase 1 RLS lockdown — close the public anon-key data exposure.
--
-- CONTEXT
--   The `anon` key ships in the browser bundle (NEXT_PUBLIC_SUPABASE_ANON_KEY),
--   so anyone can hit the PostgREST Data API with it. As of 2026-07-09, 39 of 66
--   exposed objects (incl. payroll_entries, payroll_config, pay_periods,
--   employees) had RLS OFF and were readable — and almost certainly writable —
--   by the public. This migration enables RLS on every base table.
--
-- ACCESS MODEL (why the policies look the way they do)
--   * Browser client  -> anon key, auth only (login/logout). No table reads.
--   * Server client    -> anon key + the logged-in user's JWT cookie, so it runs
--                         as the `authenticated` Postgres role. ~85 API routes +
--                         a couple server components query tables through it.
--   * Admin client     -> service_role, BYPASSES RLS. Used by webhooks, syncs,
--                         and (after this change) the payroll-advance cron.
--   Authorization is enforced in the app layer via lib/auth.ts requireRole().
--   There is no per-user row ownership (single-tenant brewery), so the DB-level
--   model is: authenticated may act; anon is denied; sensitive tables are scoped
--   to the same roles the app already requires.
--
-- MODEL A (this migration): authenticated-can-act, anon denied. Zero app-code
--   change beyond the payroll-advance cron fix (see companion commit). A later
--   Phase 3 can move server-client reads onto the service_role client and drop
--   the broad `authenticated` policies to also stop cross-role access via direct
--   PostgREST. Re-runnable: every policy uses DROP ... IF EXISTS.
-- ============================================================================

-- ── 1. Sensitive tables — scope to the same roles the app requires ──────────
-- Payroll + employee data. App routes require manager or admin (admin implicit).
-- These currently have RLS OFF, so we enable + scope them explicitly here; the
-- catch-all loop below then skips them (relrowsecurity already true).
do $$
declare
  t text;
begin
  foreach t in array array['payroll_entries', 'payroll_config', 'pay_periods', 'employees']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "manager and admin full access" on public.%I', t);
    execute format($p$
      create policy "manager and admin full access" on public.%I
        for all to authenticated
        using ((select public.get_my_role()) in ('manager'::user_role, 'admin'::user_role))
        with check ((select public.get_my_role()) in ('manager'::user_role, 'admin'::user_role))
    $p$, t);
  end loop;
end $$;

-- ── 2. Cruft — backups + drift tables slated for deletion ───────────────────
-- Enable RLS with NO policy => denies anon AND authenticated; only the
-- service_role can touch them. (These should be DROPped in a follow-up once a
-- backup is confirmed — Phase 2.) Guarded with to_regclass so this migration
-- succeeds whether or not each table still exists on the target DB.
do $$
declare
  t text;
begin
  foreach t in array array[
    'brew_batches_bak_20260704',
    'cold_storage_inventory_bak_20260704',
    'cold_storage_inventory_bak_20260707',
    'workflow_templates',
    'workflow_template_steps',
    'brew_inventory_adjustments'
  ]
  loop
    if to_regclass('public.' || quote_ident(t)) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('drop policy if exists "authenticated full access" on public.%I', t);
    end if;
  end loop;
end $$;

-- ── 3. Catch-all — every remaining base table gets authenticated-can-act ────
-- Guarantees completeness: any public base table with RLS still OFF (including
-- tables not enumerated above, and any future drift) is locked here. Tables
-- already RLS-enabled (profiles, invoices, expenses, system_settings,
-- audit_log, account_requests, the sensitive + cruft tables above, ...) are
-- skipped, so their existing bespoke policies are preserved untouched.
do $$
declare
  r record;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'          -- ordinary tables only (views handled in §4)
      and not c.relrowsecurity     -- RLS not already enabled
  loop
    execute format('alter table public.%I enable row level security', r.relname);
    execute format('drop policy if exists "authenticated full access" on public.%I', r.relname);
    execute format($p$
      create policy "authenticated full access" on public.%I
        for all to authenticated
        using (true) with check (true)
    $p$, r.relname);
  end loop;
end $$;

-- ── 4. Views — RLS does not apply; run as the invoker so underlying-table ───
-- RLS is enforced against the querying role. batch_exhaustion is the only view.
do $$
begin
  if to_regclass('public.batch_exhaustion') is not null then
    execute 'alter view public.batch_exhaustion set (security_invoker = true)';
  end if;
end $$;
