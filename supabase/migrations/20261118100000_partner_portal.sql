-- Partner portal.
--
-- A `partner` login is an EXTERNAL user: a contract-brewing / wholesale
-- partner who may see three things — open brewing capacity, beer they could
-- claim, and their own requests and history — and nothing else. Three layers
-- keep it that way, and this file is the bottom one:
--
--   1. proxy.ts confines a partner session to /partner and /api/partner.
--   2. The `partner` role bundle holds a single scope, `partner.portal`, so
--      every existing requirePermission / requirePage gate denies them.
--   3. HERE: a RESTRICTIVE policy on every public table. A partner holds a real
--      Supabase token and the anon key is public, so without this they could
--      skip the app and read "authenticated full access" tables straight from
--      PostgREST. Restrictive, because permissive policies only ever ADD
--      access — a later "authenticated can read" policy cannot reopen it.
--
-- The portal itself never reads through a partner's token: its routes use the
-- service-role client behind requirePermission(CAP.partnerPortal) and filter by
-- the session's profiles.partner_id.

-- ── Identity ────────────────────────────────────────────────────────────────
alter table public.profiles
  add column if not exists partner_id uuid references public.contract_brewing_partners(id) on delete restrict;

-- A partner login belongs to exactly one company; a staff login to none.
alter table public.profiles drop constraint if exists profiles_partner_role_pairing;
alter table public.profiles add constraint profiles_partner_role_pairing
  check ((role::text = 'partner') = (partner_id is not null));

create or replace function public.is_partner_user()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (select 1 from profiles where id = auth.uid() and role::text = 'partner');
$$;
comment on function public.is_partner_user() is
  'True when the calling session is an external partner login. Read by the restrictive partner-deny policy on every public table.';

-- proxy.ts confines partner sessions by reading app_metadata off the user it
-- already fetches, so the confinement costs no extra query. This trigger is
-- what keeps that flag true to profiles.role — app code never writes it.
create or replace function public.sync_partner_flag_to_auth()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update auth.users
     set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
                             || jsonb_build_object('portal_partner', new.role::text = 'partner')
   where id = new.id;
  return new;
end;
$$;

drop trigger if exists profiles_sync_partner_flag on public.profiles;
create trigger profiles_sync_partner_flag
  after insert or update of role on public.profiles
  for each row execute function public.sync_partner_flag_to_auth();

-- ── The role's one grant ────────────────────────────────────────────────────
insert into public.role_permission_grants (role, scope, level)
values ('partner', 'partner.portal', 'read')
on conflict (role, scope) do nothing;

-- ── Whose beer is private ───────────────────────────────────────────────────
-- Every recipe here belongs to a partner, so "hide other partners' recipes"
-- cannot be the default — it would hide all claimable beer from everyone but
-- the recipe owner. A partner whose beer must never be offered to others is
-- flagged instead; nothing is hidden until someone ticks it.
alter table public.contract_brewing_partners
  add column if not exists recipes_exclusive boolean not null default false;

-- ── Requests ────────────────────────────────────────────────────────────────
create table if not exists public.partner_requests (
  id              uuid primary key default gen_random_uuid(),
  partner_id      uuid not null references public.contract_brewing_partners(id) on delete restrict,
  kind            text not null check (kind in ('batch', 'claim')),
  recipe_id       uuid references public.recipes(id) on delete set null,
  batch_id        uuid references public.brew_batches(id) on delete set null,
  turns           int check (turns is null or turns > 0),
  volume_bbl      numeric(10,2) not null check (volume_bbl > 0),
  desired_date    date,
  notes           text,
  -- A beer we have never brewed: { name, style, abv, ingredients,
  -- instructions, ingredient_supply }. Free text on purpose — the partner does
  -- not know (and must not see) the ingredient catalogue.
  new_beer        jsonb,
  -- [{ path, name, size, type }] in the private partner-requests bucket.
  files           jsonb not null default '[]'::jsonb,
  status          text not null default 'submitted'
                  check (status in ('submitted', 'approved', 'declined', 'withdrawn')),
  channel         text check (channel is null or channel in ('distribution', 'contract_brewing', 'wholesale')),
  decision_note   text,
  decided_by      uuid references auth.users(id) on delete set null,
  decided_at      timestamptz,
  commitment_id   uuid references public.commitments(id) on delete set null,
  allocation_id   uuid references public.batch_allocations(id) on delete set null,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- A claim names the batch it draws from; a batch request names a beer or
  -- describes a new one.
  constraint partner_requests_shape check (
    (kind = 'claim' and batch_id is not null)
    or (kind = 'batch' and turns is not null and (recipe_id is not null or new_beer is not null))
  )
);
create index if not exists partner_requests_partner_idx on public.partner_requests (partner_id, created_at desc);
create index if not exists partner_requests_status_idx on public.partner_requests (status);

drop trigger if exists partner_requests_updated_at on public.partner_requests;
create trigger partner_requests_updated_at
  before update on public.partner_requests
  for each row execute function public.update_updated_at();

-- RLS on, and deliberately NO policy: only the service-role client reaches this
-- table, from routes that have already checked the caller.
alter table public.partner_requests enable row level security;

insert into storage.buckets (id, name, public)
values ('partner-requests', 'partner-requests', false)
on conflict (id) do nothing;

-- ── The taproom's reserve ───────────────────────────────────────────────────
-- Share of a batch held back for the taproom before anything is offered to
-- partners. A rule, so it lives with the other rules.
insert into public.system_settings (key, value)
values ('partner_portal_taproom_buffer_pct', '10'::jsonb)
on conflict (key) do nothing;

-- ── The deny ────────────────────────────────────────────────────────────────
create or replace function public.apply_partner_deny(p_table regclass)
returns void
language plpgsql
as $$
begin
  execute format('drop policy if exists "partner users denied" on %s', p_table);
  -- (select ...) so the planner evaluates it once per statement, not per row.
  execute format(
    'create policy "partner users denied" on %s as restrictive for all to public
       using ((select not public.is_partner_user()))
       with check ((select not public.is_partner_user()))', p_table);
end;
$$;

do $$
declare t regclass;
begin
  for t in
    select c.oid::regclass
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
       -- profiles already limits a non-admin to their own row, and the session
       -- resolver reads that row through the partner's own token.
       and c.relname <> 'profiles'
  loop
    perform public.apply_partner_deny(t);
  end loop;
end $$;

-- Tables nobody has denied yet. Must return zero rows; a table created after
-- this migration shows up here until apply_partner_deny() is run on it.
create or replace function public.partner_deny_gaps()
returns table (table_name text)
language sql
stable
as $$
  select c.relname::text
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname <> 'profiles'
     and not exists (
       select 1 from pg_policy p
        where p.polrelid = c.oid and p.polname = 'partner users denied' and not p.polpermissive)
   order by 1;
$$;
revoke all on function public.partner_deny_gaps() from public, anon, authenticated;
revoke all on function public.apply_partner_deny(regclass) from public, anon, authenticated;

-- New tables get the deny automatically. Event triggers need a privilege not
-- every environment grants, so failing to create one is a notice, not an
-- error — partner_deny_gaps() is the check that does not depend on it.
create or replace function public.partner_deny_on_create_table()
returns event_trigger
language plpgsql
as $$
declare obj record;
begin
  for obj in select * from pg_event_trigger_ddl_commands() where command_tag = 'CREATE TABLE' loop
    if obj.schema_name = 'public' and obj.object_identity <> 'public.profiles' then
      perform public.apply_partner_deny(obj.objid::regclass);
      execute format('alter table %s enable row level security', obj.objid::regclass);
    end if;
  end loop;
end;
$$;

do $$
begin
  drop event trigger if exists partner_deny_new_tables;
  create event trigger partner_deny_new_tables on ddl_command_end
    when tag in ('CREATE TABLE') execute function public.partner_deny_on_create_table();
exception when insufficient_privilege then
  raise notice 'partner_deny_new_tables not created (insufficient privilege); rely on partner_deny_gaps()';
end $$;
