-- ============================================================================
-- Repair: effective_grant_level() never picked up its 20260826 body in prod.
--
-- WHAT HAPPENED
--   20260826_role_permission_grants.sql does two things: it creates and seeds
--   role_permission_grants, and it REDEFINES effective_grant_level() to resolve
--   role bundles in addition to per-user rows. In production only the first
--   half took effect. The table is there with all 24 seeded rows; the function
--   is still the 20260822 body, which short-circuits on
--   `get_my_role() = 'custom'` and therefore never reads the table at all.
--
--   Confirmed against prod on 2026-08-07 by calling the function over PostgREST
--   as a signed-in admin:
--       effective_grant_level('')                 -> null
--       effective_grant_level('payroll')          -> null
--       effective_grant_level('production.brewing') -> null
--   An admin holds ('admin', '', 'admin'), so the ROOT arm alone should return
--   'admin' for every scope. Null at every scope is only possible with the old
--   body. (This is the migration-version hazard scripts/check-migrations.mjs
--   documents: 20260825/20260826 were hand-applied in parallel pairs.)
--
-- WHY A NEW FILE RATHER THAN EDITING 20260826
--   That version is already recorded as applied, so `db push` would skip it and
--   prod would stay broken. The body below is byte-for-byte 20260826's, so the
--   two files agree and lib/auth/__tests__/rlsGrantParity.test.ts — which
--   asserts against 20260826 — keeps passing unchanged.
--
-- BLAST RADIUS — additive, and narrower than it looks.
--   has_grant() gates 19 tables (10 payroll via 20260822's DO block, 9 finance
--   via later apply_grant_policies calls). Today every one of them denies every
--   non-custom user, because the resolver returns null. After this:
--     admin   ROOT ''            -> gains read+operate on all 19. On the 10
--                                  payroll tables that is a no-op: the untouched
--                                  "payroll readers" policy already allows
--                                  admin. The real change is the 9 finance
--                                  tables, which is the intent those
--                                  apply_grant_policies calls already encoded.
--     manager payroll:operate    -> no change; "payroll readers" already covers
--                                  it, and manager holds no finance.* grant.
--     brewer  no payroll/finance -> no change. Its bundle is catalog,
--                                  production.*, taproom.*, finance.tax.filing;
--                                  none of those scope any of the 19 tables.
--     viewer  taproom.* only     -> no change.
--     custom  unchanged. role_permission_grants deliberately has no 'custom'
--             rows, so the union adds nothing, and the added
--             `c.precedence desc` tiebreak cannot reorder a single-arm result.
--   So this can only widen admin, onto tables admin is meant to reach. It
--   cannot narrow anyone.
--
--   NOT touched here: finance_reader_roles() still returns an empty array, so
--   the 14 tax/finance tables behind it stay service-role-only. Converting
--   those is a separate, genuinely access-widening change.
-- ============================================================================

create or replace function public.effective_grant_level(p_scope text)
  returns permission_level
  language sql
  stable
  security definer
  set search_path = public
as $fn$
  with candidates as (
    select g.scope, g.level, 1 as precedence
    from public.user_permission_grants g
    where g.user_id = auth.uid()
      and public.get_my_role() = 'custom'::user_role
    union all
    select r.scope, r.level, 0 as precedence
    from public.role_permission_grants r
    where r.role = public.get_my_role()
  )
  select c.level
  from candidates c
  where c.scope = ''
     or c.scope = p_scope
     or starts_with(p_scope, c.scope || '.')
  order by length(c.scope) desc, c.precedence desc
  limit 1
$fn$;

comment on function public.effective_grant_level(text) is
  'SQL mirror of effectiveLevel() in lib/auth/resolve.ts: longest-prefix-wins over the caller''s role bundle (role_permission_grants) plus, for role = custom, their per-user rows. A per-user row outranks a role row at the same key length. NULL when nothing matches.';

-- 20260822 granted EXECUTE to authenticated and revoked it from anon/public.
-- CREATE OR REPLACE preserves the existing ACL, so those grants carry over.
-- Re-asserted anyway: this file has to be safe to run against an environment
-- that somehow lost them, and both statements are idempotent.
revoke execute on function public.effective_grant_level(text) from anon, public;
grant execute on function public.effective_grant_level(text) to authenticated;
