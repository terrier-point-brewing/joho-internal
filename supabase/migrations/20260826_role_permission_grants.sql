-- ============================================================================
-- Editable preset-role bundles.
--
-- Until now the four static roles resolved from a hardcoded TS constant
-- (lib/auth/roleGrants.ts) with zero DB round-trips, so changing what a
-- manager can do meant a code change and a deploy. This makes the bundles
-- data, which is what lets a capability be handed back — e.g. manager's
-- `manage` — through Settings -> Users -> Roles instead of a release.
--
-- SAFE TO APPLY LATE. The app falls back to the TS constant whenever this
-- table cannot be read, so behaviour is identical before and after — which
-- matters because prod migrations here are human-gated and may lag the deploy.
--
-- Design: docs/superpowers/specs/2026-07-28-scope-structure-analysis.md
-- ============================================================================

create table if not exists role_permission_grants (
  role       user_role not null,
  scope      text not null,
  level      permission_level not null,
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now(),
  primary key (role, scope)
);

alter table role_permission_grants enable row level security;

-- Every session resolves its own role's bundle through the SERVER client, so
-- authenticated must be able to read. There is nothing sensitive here — it is
-- the same matrix the admin UI already renders. Writes are service_role only
-- (admin client), so no authenticated write policy.
create policy "authenticated read role grants" on role_permission_grants
  for select to authenticated using (true);

-- ── Seed: byte-for-byte the ROLE_BUNDLES constant at 2026-07-28 ─────────────
-- Asserted by lib/auth/__tests__/roleBundleSeedParity.test.ts, so the seed and
-- the constant cannot drift apart silently. `custom` is deliberately absent:
-- those users resolve from user_permission_grants, and an empty bundle here
-- keeps that behaviour while leaving room to give custom a base later.
insert into role_permission_grants (role, scope, level) values
  ('admin',   '',                       'admin'),

  ('manager', 'taproom',                'operate'),
  ('manager', 'taproom.targets',        'read'),
  ('manager', 'payroll',                'operate'),
  ('manager', 'production.access',      'read'),
  ('manager', 'production.export',      'read'),
  ('manager', 'production.partners',    'read'),
  ('manager', 'production.settings',    'operate'),

  ('brewer',  'taproom.access',         'read'),
  ('brewer',  'taproom.performance',    'read'),
  ('brewer',  'taproom.targets',        'read'),
  ('brewer',  'production.access',      'read'),
  ('brewer',  'production.brewing',     'operate'),
  ('brewer',  'production.inventory',   'operate'),
  ('brewer',  'production.export',      'operate'),
  ('brewer',  'production.recipes',     'operate'),
  ('brewer',  'production.partners',    'operate'),
  ('brewer',  'production.settings',    'manage'),
  ('brewer',  'production.equipment',   'read'),
  ('brewer',  'catalog',                'manage'),
  ('brewer',  'finance.tax.filing',     'read'),

  ('viewer',  'taproom.access',         'read'),
  ('viewer',  'taproom.performance',    'read'),
  ('viewer',  'taproom.targets',        'read')
on conflict (role, scope) do nothing;

-- ── Resolver: the SQL mirror now spans BOTH grant sources ───────────────────
-- 20260822 short-circuited on `get_my_role() = 'custom'`, which was correct
-- when non-custom roles had no DB-resolvable grants at all. With bundles as
-- data that would make Postgres deny what the app layer allows — the exact
-- divergence 20260822 existed to fix.
--
-- Precedence, matching lib/auth/resolve.ts: longest dot-prefix wins; at equal
-- key length a per-user row beats a role row, so a user-level grant can
-- override its own role's bundle at the same scope (including an explicit
-- 'none' revoke).
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

-- ADVISOR NOTE: role_permission_grants is world-readable to authenticated on
-- purpose (see policy comment). It contains no user data — only the role
-- matrix — so 0013/0006 do not apply.
