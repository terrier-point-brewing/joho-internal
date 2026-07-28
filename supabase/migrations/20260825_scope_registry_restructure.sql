-- ============================================================================
-- Scope registry restructure — rewrite user_permission_grants onto the new
-- 27-key tree.
--
-- WHY: the scope tree was serving three purposes at once (nav mirror, domain
-- model, admission control). It now models the DOMAIN only; admission moved to
-- `<section>.access` leaves, depth lives on the level ladder, and two scopes
-- that were reachable from more than one section became top-level (`payroll`
-- was already, `catalog` is new).
--
-- POPULATION: role = 'custom' is the ONLY role that reads this table — the four
-- static roles resolve from ROLE_BUNDLES in TS with zero DB round-trips. As of
-- 2026-07-28 that is exactly one user holding seven bare section grants, all at
-- `read`. This migration is written to be correct for any grant set, not just
-- that one.
--
-- PRESERVES REACH. Two of the rewrites exist purely so nobody silently loses
-- access that the app-layer change would otherwise take away:
--   * `settings` no longer resolves anything, so a `settings`-prefixed holder
--     would lose the Cron Jobs tab. -> renamed to `org`.
--   * `production` no longer covers Square Item Mappings. -> an explicit
--     `catalog` row is synthesised at whatever level `production.settings`
--     used to resolve to.
--
-- Design + evidence: docs/superpowers/specs/2026-07-28-scope-structure-analysis.md
-- Spec: docs/superpowers/specs/2026-07-28-scope-structure-spec.md
--
-- HUMAN-GATED. Do not apply without explicit approval and a backup. Run the
-- BEFORE/AFTER reports at the bottom around it.
-- ============================================================================

begin;

-- ── 1. Straight renames ─────────────────────────────────────────────────────
-- Insert-then-delete rather than UPDATE: the primary key is (user_id, scope),
-- so an UPDATE would blow up where the destination row already exists. Where
-- both exist the EXISTING row wins — it was set deliberately and this migration
-- has no business overriding it.
--
-- `tax` -> `finance.tax` keeps an EXPLICIT row even for holders who also carry
-- a bare `finance` grant that would cover it by prefix. That is deliberate:
-- today those are two independent rows, so revoking `finance` later would leave
-- tax access standing. Collapsing them would quietly change that.
with renames(old_scope, new_scope) as (
  values
    ('tax',              'finance.tax'),
    ('tax.pii',          'finance.tax.pii'),
    ('settings',         'org'),
    ('settings.business','org.business'),
    ('settings.users',   'org.users'),
    ('settings.cron',    'org.jobs')
)
insert into user_permission_grants (user_id, scope, level, granted_by, granted_at)
select g.user_id, r.new_scope, g.level, g.granted_by, g.granted_at
from user_permission_grants g
join renames r on r.old_scope = g.scope
on conflict (user_id, scope) do nothing;

-- ── 2. brand.workbench splits two ways ──────────────────────────────────────
-- The scope conflated the asset library with the label-release workbench;
-- a holder of the old one keeps both at the same level.
insert into user_permission_grants (user_id, scope, level, granted_by, granted_at)
select g.user_id, s.new_scope, g.level, g.granted_by, g.granted_at
from user_permission_grants g
cross join (values ('brand.assets'), ('brand.releases')) as s(new_scope)
where g.scope = 'brand.workbench'
on conflict (user_id, scope) do nothing;

-- ── 3. Synthesise `catalog` from the old production.settings reach ──────────
-- Square Item Mappings used to answer to production.settings (and, via the
-- taproom mount, to taproom.settings). It is now its own top-level scope, which
-- no existing row covers by prefix — so resolve what each user's grants USED to
-- give them on production.settings and carry that level across.
--
-- This is the same longest-prefix-wins rule as effectiveLevel() in
-- lib/auth/resolve.ts and effective_grant_level() in 20260822, inlined here
-- because those resolve for auth.uid() only and this is a set-based backfill.
-- An explicit 'none' is a revoke and must NOT become a catalog grant.
with resolved as (
  select distinct on (g.user_id)
         g.user_id,
         g.level
  from user_permission_grants g
  where g.scope = ''
     or g.scope = 'production.settings'
     or starts_with('production.settings', g.scope || '.')
  order by g.user_id, length(g.scope) desc
)
insert into user_permission_grants (user_id, scope, level, granted_by, granted_at)
select r.user_id, 'catalog', r.level, null, now()
from resolved r
where r.level <> 'none'
on conflict (user_id, scope) do nothing;

-- ── 4. Drop retired scopes ──────────────────────────────────────────────────
-- `taproom.settings` retired with zero screens of its own (its only screen was
-- Square Item Mappings, now `catalog`, handled above). The renamed and split
-- originals go last, so a failure in steps 1-3 leaves the old rows intact.
delete from user_permission_grants
where scope in (
  'taproom.settings',
  'brand.workbench',
  'tax', 'tax.pii',
  'settings', 'settings.business', 'settings.users', 'settings.cron'
);

-- ── 5. Guard: nothing may reference a scope the app no longer knows ─────────
-- ROOT plus the 27 keys and the 7 section prefixes of lib/auth/scopes.ts. If
-- this fires, a grant row would resolve to nothing and the user would lose
-- access silently — exactly what this migration exists to prevent.
do $$
declare bad text;
begin
  select string_agg(distinct scope, ', ') into bad
  from user_permission_grants
  where scope <> ''
    and scope not in (
      'taproom', 'production', 'finance', 'payroll', 'catalog', 'brand', 'org',
      'taproom.access', 'taproom.performance', 'taproom.targets',
      'production.access', 'production.brewing', 'production.inventory',
      'production.export', 'production.recipes', 'production.partners',
      'production.equipment', 'production.settings',
      'finance.access', 'finance.statements', 'finance.transactions',
      'finance.tax', 'finance.tax.filing', 'finance.tax.pii',
      'brand.access', 'brand.guide', 'brand.assets', 'brand.releases',
      'org.users', 'org.business', 'org.jobs', 'org.appearance'
    );
  if bad is not null then
    raise exception 'user_permission_grants references unknown scope(s): %', bad;
  end if;
end $$;

commit;

-- ============================================================================
-- REPORTS — run BEFORE and AFTER, and diff them.
--
--   select p.email, g.scope, g.level
--   from user_permission_grants g join profiles p on p.id = g.user_id
--   order by p.email, g.scope;
--
-- Expected for the single custom user as of 2026-07-28
-- (jeffkliao@gmail.com, seven bare `read` grants):
--
--   BEFORE                      AFTER
--   brand: read                 brand: read
--   finance: read               finance: read
--   payroll: read               payroll: read
--   production: read            production: read
--   settings: read              org: read          <- renamed
--   taproom: read               taproom: read
--   tax: read                   finance.tax: read  <- renamed
--                               catalog: read      <- synthesised (step 3)
--
-- Eight rows out, seven in: same effective reach, no widening. Per the
-- 2026-07-28 decision (Q-W7) everything stays at `read`; further tuning
-- happens through Settings -> Users -> Grants, not another migration.
-- ============================================================================
