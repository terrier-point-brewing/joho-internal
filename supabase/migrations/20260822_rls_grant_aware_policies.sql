-- ============================================================================
-- Grant-aware RLS — let role = 'custom' reach the payroll tables its
-- user_permission_grants rows actually authorize.
--
-- PROBLEM
--   20260819/20260820 added the 'custom' role and per-user (scope, level)
--   grants, and the app layer honors them (lib/auth/resolve.ts + guard.ts).
--   The DB layer does not: every payroll policy gates on
--   `get_my_role() = any (payroll_reader_roles())`, whose array is
--   {manager, admin}. No policy anywhere consults user_permission_grants. The
--   payroll routes query through the SERVER client (RLS enforced, unlike the
--   finance/tax routes which use the admin client), so a custom user with a
--   payroll grant passes requirePermission() and is then denied by Postgres.
--
-- SCOPE — payroll only, and that is deliberate. A full inventory of
--   role-name-based policies is in the design doc; the short version is that
--   payroll is the only group where a role-name check sits in front of a
--   server-client read path. finance_reader_roles() returns an EMPTY array on
--   purpose: those tables are service-role-only and every consumer uses the
--   admin client. Adding grant policies there would OPEN a Data API surface
--   that is currently deliberately shut, for zero functional gain. Same for
--   audit_log / account_requests / profiles (admin-client only).
--
-- APPROACH — additive. The existing "payroll readers" policies are left
--   untouched, so manager/admin behavior cannot regress; permissive policies
--   OR together, so this can only ADD access for 'custom'.
--
-- Design + rationale: docs/superpowers/specs/2026-07-27-rls-grant-aware-policies-design.md
-- ============================================================================

-- ── 1. Resolver — the SQL mirror of lib/auth/resolve.ts ────────────────────
-- Longest-prefix-wins over dot-delimited scope keys, exactly as effectiveLevel()
-- does. Three match arms: ROOT (''), exact, and dot-prefix.
--
-- starts_with() rather than `LIKE g.scope || '.%'` on purpose — LIKE would
-- treat an underscore in a future scope key as a single-char wildcard.
--
-- ROOT has length 0 so it sorts LAST under `order by length desc`, which is
-- correct: it is the weakest possible match.
--
-- The `get_my_role() = 'custom'` gate mirrors getSessionUser(), which consults
-- this table only for that role. It is not merely cosmetic: without it, a user
-- switched from 'custom' back to 'viewer' while stale grant rows remain would
-- keep DB access the app layer has already revoked.
create or replace function public.effective_grant_level(p_scope text)
  returns permission_level
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  select g.level
  from public.user_permission_grants g
  where g.user_id = auth.uid()
    and public.get_my_role() = 'custom'::user_role
    and ( g.scope = ''
          or g.scope = p_scope
          or starts_with(p_scope, g.scope || '.') )
  order by length(g.scope) desc
  limit 1
$fn$;

comment on function public.effective_grant_level(text) is
  'SQL mirror of effectiveLevel() in lib/auth/resolve.ts: longest-prefix-wins over the caller''s user_permission_grants rows. NULL when no grant matches, or when the caller is not role = custom.';

-- The rank comparison rides on Postgres enum ordering, which follows the
-- declaration order in 20260820:
--   ('none','read','operate','manage','admin')
-- That is the same order as RANK in lib/auth/levels.ts, so `>=` IS the rank
-- check. LOAD-BEARING COUPLING: reordering either side without the other
-- silently changes who can read payroll. Asserted by
-- lib/auth/__tests__/rlsGrantParity.test.ts.
--
-- coalesce(..., false) collapses the two denial paths the way can() does:
-- 'none' loses the >= comparison, an absent grant is NULL.
create or replace function public.has_grant(p_scope text, p_need permission_level)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  select coalesce(public.effective_grant_level(p_scope) >= p_need, false)
$fn$;

comment on function public.has_grant(text, permission_level) is
  'SQL mirror of can() in lib/auth/resolve.ts. Used in RLS policies; wrap calls in (select ...) so the planner caches them as an InitPlan instead of re-evaluating per row.';

-- Policy expressions are evaluated with the querying role's privileges, so
-- `authenticated` needs EXECUTE. anon must not.
--
-- Both functions must stay SECURITY DEFINER: user_permission_grants' own RLS
-- policy is `user_id = auth.uid()`, and get_my_role() (which these call) is
-- DEFINER for the same reason. Leaving them callable by `authenticated` trips
-- advisor 0029, the same accepted exception documented for get_my_role() in
-- 20260709_security_advisor_hardening.sql — they only ever report facts about
-- the caller's own grants, so exposure is nil.
revoke execute on function public.effective_grant_level(text) from anon, public;
revoke execute on function public.has_grant(text, permission_level) from anon, public;
grant execute on function public.effective_grant_level(text) to authenticated;
grant execute on function public.has_grant(text, permission_level) to authenticated;

-- ── 2. Applicator — one edit-point for every future grant-gated table ──────
-- Idempotent and to_regclass-guarded, so it is safe to re-run and safe to call
-- for a table that a not-yet-merged branch creates.
--
-- Read and write are split rather than sharing one `for all` predicate: a
-- custom user granted `payroll: read` gets SELECT but is still denied writes by
-- Postgres even if an app route forgets its guard. That is the defense-in-depth
-- this whole change exists to preserve.
create or replace function public.apply_grant_policies(p_table text, p_scope text)
  returns void
  language plpgsql
  set search_path = public          -- advisor 0011
as $fn$
begin
  if to_regclass('public.' || quote_ident(p_table)) is null then
    return;
  end if;

  execute format('drop policy if exists "grant read" on public.%I', p_table);
  execute format('drop policy if exists "grant write" on public.%I', p_table);

  execute format($p$
    create policy "grant read" on public.%I
      for select to authenticated
      using ( (select public.has_grant(%L, 'read'::permission_level)) )
  $p$, p_table, p_scope);

  execute format($p$
    create policy "grant write" on public.%I
      for all to authenticated
      using ( (select public.has_grant(%L, 'operate'::permission_level)) )
      with check ( (select public.has_grant(%L, 'operate'::permission_level)) )
  $p$, p_table, p_scope, p_scope);
end
$fn$;

comment on function public.apply_grant_policies(text, text) is
  'Attaches grant-aware read/write RLS policies for a scope to a table. No-op if the table does not exist. Call this instead of hand-writing the policy pair.';

-- DDL applicator — must never be reachable over /rest/v1/rpc/*. It is SECURITY
-- INVOKER, so a non-owner call would fail on CREATE POLICY anyway; revoking is
-- the belt to that suspenders.
revoke execute on function public.apply_grant_policies(text, text) from public, anon, authenticated;

-- ── 3. Apply to the payroll group ──────────────────────────────────────────
-- Every table currently carrying a "payroll readers" policy:
--   * 20260709_rls_phase3_tighten_sensitive.sql — the original four
--   * 20260714_payroll_gl_split.sql             — five GL-split tables
--   * 20260821_payroll_shift_overrides.sql      — PR #277, may not exist yet
-- payroll_period_expense_matches and expense_gl_splits are intentionally
-- ABSENT: 20260714 put them under finance_reader_roles(), i.e. service-role
-- only, and they are read via the admin client.
do $$
declare t text;
begin
  foreach t in array array[
    'payroll_entries',
    'payroll_config',
    'pay_periods',
    'employees',
    'payroll_department_gl_mappings',
    'payroll_gl_settings',
    'payroll_gl_reports',
    'payroll_gl_report_employees',
    'payroll_gl_report_totals',
    'payroll_shift_overrides'
  ]
  loop
    perform public.apply_grant_policies(t, 'payroll');
  end loop;
end $$;

-- ADVISOR NOTE: these tables now carry three permissive policies for
-- authenticated SELECT ("payroll readers", "grant read", "grant write"), which
-- trips lint 0006 multiple_permissive_policies. That is the cost of keeping the
-- change additive — collapsing them into one predicate would mean rewriting the
-- working manager/admin policy. Accepted; the (select ...) wrappers keep each
-- predicate to a single InitPlan evaluation per query.
--
-- ORDERING NOTE: if 20260821 (PR #277) is applied to prod AFTER this file,
-- payroll_shift_overrides will be created with only its "payroll readers"
-- policy. Re-run the DO block above (idempotent), or have that migration call
--   perform public.apply_grant_policies('payroll_shift_overrides', 'payroll');
