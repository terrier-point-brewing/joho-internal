-- ============================================================================
-- RLS Phase 3 (approach A1) — tighten sensitive tables at the DB layer.
--
-- Closes the cross-role gap left by Phase 1: a signed-in low-privilege user
-- (viewer/brewer) could take their Supabase JWT and read finance data directly
-- from the Data API, bypassing the app's requireRole checks. Middleware cannot
-- fix this (it guards the app's routes, not the separate PostgREST host); only
-- RLS can.
--
-- Design + rationale: docs/superpowers/specs/2026-07-09-rls-phase3-tighten-sensitive-tables-design.md
--
-- Group 1 (finance) -> service-role-only. Verified 2026-07-09: every one of
--   these tables is accessed ONLY via the admin (service_role) client in the app
--   (all /api/finance/* routes + lib/finance/* + relevant production invoice
--   routes). Their pre-existing policies granted authenticated/viewer READ via
--   the Data API — the exact exposure being closed. service_role bypasses RLS,
--   so denying `authenticated` breaks nothing.
-- Group 2 (payroll/PII) -> manager+admin, refactored onto a shared helper.
-- Group 3 -> untouched (operational tables legitimately read via the server
--   client stay at authenticated-read).
--
-- Extensibility: the allowed-role set for each tier lives in ONE constant
-- function. Granting a future role (e.g. an accountant/finance role) read access
-- to all finance tables is a one-line edit to finance_reader_roles().
-- ============================================================================

-- ── Role-set helpers (single edit-point per tier) ──────────────────────────
-- Pure constant functions (no table reads, not SECURITY DEFINER) — add no
-- advisor findings. `get_my_role() = any('{}')` is false for every role, so an
-- empty set = service-role-only.
create or replace function public.finance_reader_roles()
  returns user_role[] language sql immutable
  as $$ select array[]::user_role[] $$;   -- empty = service-role-only today

create or replace function public.payroll_reader_roles()
  returns user_role[] language sql immutable
  as $$ select array['manager','admin']::user_role[] $$;

-- ── Group 1 — finance: drop ALL existing policies, apply service-role-only ──
do $$
declare
  t text;
  pol text;
begin
  foreach t in array array[
    'invoice_line_items','invoice_batch_links','expenses','expense_account_mappings',
    'chart_of_accounts','pos_line_items','square_orders','square_refunds'
  ]
  loop
    for pol in
      select polname from pg_policy where polrelid = ('public.'||quote_ident(t))::regclass
    loop
      execute format('drop policy if exists %I on public.%I', pol, t);
    end loop;
    execute format($p$
      create policy "finance readers" on public.%I
        for all to authenticated
        using ( public.get_my_role() = any (public.finance_reader_roles()) )
        with check ( public.get_my_role() = any (public.finance_reader_roles()) )
    $p$, t);
  end loop;
end $$;

-- ── Group 2 — payroll/PII: manager+admin via the shared helper ─────────────
do $$
declare t text;
begin
  foreach t in array array['payroll_entries','payroll_config','pay_periods','employees']
  loop
    execute format('drop policy if exists "manager and admin full access" on public.%I', t);
    execute format('drop policy if exists "payroll readers" on public.%I', t);
    execute format($p$
      create policy "payroll readers" on public.%I
        for all to authenticated
        using ( public.get_my_role() = any (public.payroll_reader_roles()) )
        with check ( public.get_my_role() = any (public.payroll_reader_roles()) )
    $p$, t);
  end loop;
end $$;
