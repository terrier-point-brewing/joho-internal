-- ─── Marketing chassis: the tables, and nothing that reads or writes them ─────
--
-- Marketing is one calendar holding posts, reels, stories and boosts; a robot
-- that publishes what is on the calendar through pluggable channels; and later
-- an assistant that proposes entries. A human approves — nothing publishes or
-- spends without a person having said so.
--
-- This migration builds the storage for all of that and NO consumer. Every
-- table here is inert until later chips arrive. That is deliberate: the schema
-- is the expensive part to get wrong, so it lands alone, once.
--
-- One brand. There is no brand_id and no per-brand scoping anywhere.
--
-- ── Why `public.marketing_*` and not a `marketing` schema ────────────────────
-- The design spec asked for a separate Postgres schema. It does not get one.
-- No migration in this repo's 241 uses `create schema`, and decisively:
-- public.apply_grant_policies(table, scope) — the house RLS applicator from
-- 20260822_rls_grant_aware_policies.sql — hard-codes `public.`. A separate
-- schema would mean hand-writing every policy pair by hand, which is precisely
-- the drift that function exists to prevent.
--
-- ── Two scopes that are not registered yet, on purpose ───────────────────────
-- The grant-gated tables below are applied against `marketing.calendar` and
-- `marketing.publish`. Neither string exists in lib/auth/scopes.ts today —
-- later chips add them, because check-permissions.mjs fails on a scope with no
-- capability referencing it. This is fine and intended: has_grant() resolves
-- plain text, `admin` satisfies anything through its ROOT row in
-- role_permission_grants, and every other role is denied until the scope
-- becomes grantable. DO NOT "fix" this by registering the scopes here.

-- ─── 1. marketing_connected_accounts ─────────────────────────────────────────
-- One login to one channel. This is the credential table, and its access
-- posture is the strictest in the file — see section 7.
--
-- `provider` and `channel` are free text rather than enums or CHECKs on
-- purpose. The vocabulary belongs to the plugin registry, not to the database:
-- adding a channel should be a code change plus a row, never a type migration.
create table if not exists public.marketing_connected_accounts (
  id                 uuid        primary key default gen_random_uuid(),

  provider           text        not null,
  channel            text        not null,

  -- The account's identifier AT the provider, and the parent object it hangs
  -- off where the provider has one (an Instagram business account under a
  -- Facebook page, say). Null while a connection is half-configured.
  external_id        text,
  external_parent_id text,

  -- The public handle, for showing a person which account they are looking at
  -- without decoding an opaque provider id.
  handle             text,

  -- SECRET. Service-role only; never expose through an API response, never
  -- select it into one. Stored in the clear in a table with no RLS policies
  -- and no Data API grants, which is a stronger guarantee than ciphertext
  -- behind a readable policy would be. Same shape and same rule as
  -- integration_connections.credentials (20260913090000).
  credentials        jsonb       not null default '{}',

  -- When the stored credential stops working. Null where the provider issues a
  -- token that does not expire.
  token_expires_at   timestamptz,

  -- What the token is actually authorized to do at the provider. Recorded so a
  -- publish failure can be told apart from a missing scope without a round trip.
  scopes             text[],

  status             text        not null default 'connected'
                       check (status in ('connected', 'error', 'disconnected')),
  last_error         text,
  last_verified_at   timestamptz,

  created_at         timestamptz not null default now(),
  created_by         uuid        references auth.users(id),
  updated_at         timestamptz not null default now()
);

comment on table public.marketing_connected_accounts is
  'One row per login to one channel. Holds the publishing credential. Service-role only: RLS is on, there are no policies, and the Data API grants are revoked — every consumer goes through createSupabaseAdminClient() behind a requirePermission() guard.';
comment on column public.marketing_connected_accounts.credentials is
  'SECRET. Service-role only; never expose through an API response. Cleartext in a table with no policies and no anon/authenticated grants, deliberately — see the header of this migration.';
comment on column public.marketing_connected_accounts.provider is
  'The upstream service (e.g. meta). Free text: the vocabulary belongs to the plugin registry, not to a CHECK constraint.';
comment on column public.marketing_connected_accounts.channel is
  'The surface published to (e.g. instagram). Free text, for the same reason as provider.';
comment on column public.marketing_connected_accounts.external_parent_id is
  'The provider-side object this account hangs off, where there is one. Null otherwise.';
comment on column public.marketing_connected_accounts.status is
  'connected | error (last verify or publish failed, see last_error) | disconnected (a person unlinked it).';

-- One account per channel per provider. There is one brand, so there is one
-- Instagram, one Facebook page, one of each.
create unique index if not exists marketing_connected_accounts_provider_channel
  on public.marketing_connected_accounts (provider, channel);

-- ─── 2. marketing_media ──────────────────────────────────────────────────────
-- The marketing library: uploads and finished creatives. Distinct from
-- brand_assets, which is the brand guide's own library and lives in a private
-- bucket; these are the files a channel will be handed a URL to.
create table if not exists public.marketing_media (
  id           uuid        primary key default gen_random_uuid(),

  -- 'video' is accepted by the schema from day one and handled by nothing.
  -- That is a deliberate open extension point, not a feature.
  type         text        not null check (type in ('image', 'video')),

  -- The public URL a channel fetches the creative from, and the object key
  -- inside the marketing-media bucket that produced it. Both are kept: the URL
  -- is what gets handed out, the path is what gets deleted.
  url          text        not null,
  storage_path text        not null,

  width        integer,
  height       integer,
  duration_s   numeric,
  bytes        bigint,

  -- Free-form labels for finding a creative again. No controlled vocabulary.
  tags         text[],

  created_at   timestamptz not null default now(),
  created_by   uuid        references auth.users(id),
  updated_at   timestamptz not null default now()
);

comment on table public.marketing_media is
  'The marketing library — uploads and finished creatives. Separate from brand_assets (private bucket, brand guide); these live in the public marketing-media bucket because a channel fetches them by URL.';
comment on column public.marketing_media.type is
  'image | video. video is storable from day one and consumed by nothing yet — an open extension point, not a shipped feature.';
comment on column public.marketing_media.storage_path is
  'Object key inside the marketing-media bucket: {yyyy}/{mm}/{uuid}.{ext}.';
comment on column public.marketing_media.duration_s is
  'Duration in seconds. Null for stills.';

-- ─── 3. marketing_calendar_entries ───────────────────────────────────────────
-- Anything on the calendar. An entry is a MOMENT when ends_at is null and a
-- BAND when it is set — a post happens at 9am, a boost runs Friday to Sunday.
create table if not exists public.marketing_calendar_entries (
  id         uuid        primary key default gen_random_uuid(),

  -- post | reel | story | boost | whatever a plugin registers next. Free text,
  -- for the same reason provider and channel are.
  kind       text        not null,

  starts_at  timestamptz not null,
  ends_at    timestamptz,

  caption    text,

  -- A per-kind bag owned by the plugin for that kind. THE CHASSIS NEVER READS
  -- THIS. Nothing outside a plugin may reach into it, and no chassis query may
  -- filter on a key inside it.
  details    jsonb       not null default '{}',

  -- App code sets only draft and approved. Everything else is written by
  -- public.marketing_entry_status_refresh() off the entry's deliveries.
  status     text        not null default 'draft'
               check (status in ('draft', 'approved', 'scheduled', 'in_progress', 'done', 'failed')),

  -- 'assistant' is valid from day one and written by nothing.
  origin     text        not null default 'manual'
               check (origin in ('manual', 'rule', 'assistant')),

  tags       text[],

  created_at timestamptz not null default now(),
  created_by uuid        references auth.users(id),
  updated_at timestamptz not null default now()
);

comment on table public.marketing_calendar_entries is
  'Anything on the marketing calendar. A moment when ends_at is null, a band when it is set.';
comment on column public.marketing_calendar_entries.details is
  'Per-kind payload OWNED BY THE PLUGIN for that kind. The chassis never reads it and never filters on a key inside it.';
comment on column public.marketing_calendar_entries.status is
  'App code sets draft and approved ONLY. scheduled | in_progress | done | failed are derived from the entry''s deliveries by marketing_entry_status_refresh().';
comment on column public.marketing_calendar_entries.origin is
  'manual (a person) | rule (a recurring rule) | assistant (proposed). assistant is accepted from day one and written by nothing.';
comment on column public.marketing_calendar_entries.ends_at is
  'Null means the entry is a moment. Set means it is a band, e.g. a boost that runs across days.';

-- The calendar is read a month at a time; every query starts here.
create index if not exists marketing_calendar_entries_starts_at
  on public.marketing_calendar_entries (starts_at);

-- ─── 4. marketing_entry_media ────────────────────────────────────────────────
-- Which media an entry uses, in the order a carousel shows them. Zero rows is
-- legal and means a text-only entry.
create table if not exists public.marketing_entry_media (
  entry_id uuid    not null references public.marketing_calendar_entries(id) on delete cascade,
  media_id uuid    not null references public.marketing_media(id),
  position integer not null,

  primary key (entry_id, media_id)
);

comment on table public.marketing_entry_media is
  'Which media an entry uses, ordered. Zero rows is legal and means a text-only entry.';
comment on column public.marketing_entry_media.position is
  'Display order within the entry, e.g. carousel slide order. Not unique — reordering must not need a two-phase write.';

-- ─── 5. marketing_deliveries ─────────────────────────────────────────────────
-- One row per entry × channel. This is the robot's work queue: an entry going
-- to Instagram and Facebook is one entry and two deliveries, each succeeding or
-- failing on its own.
create table if not exists public.marketing_deliveries (
  id            uuid        primary key default gen_random_uuid(),

  entry_id      uuid        not null references public.marketing_calendar_entries(id) on delete cascade,

  -- Nullable, and `set null` rather than cascade: a delivery that already
  -- published is a historical fact, and unlinking the account it went through
  -- must not erase it. A pending delivery with a null account is unclaimable,
  -- which is the correct outcome.
  account_id    uuid        references public.marketing_connected_accounts(id) on delete set null,

  -- Denormalized from the account so a delivery still says where it went after
  -- the account row is gone.
  channel       text        not null,

  scheduled_at  timestamptz,

  status        text        not null default 'pending'
                  check (status in ('pending', 'scheduled', 'publishing', 'published', 'failed', 'skipped')),

  -- Provider-side ids the publish returned (post id, media container id, …).
  external_ids  jsonb       not null default '{}',

  error         text,
  attempt_count integer     not null default 0,
  published_at  timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.marketing_deliveries is
  'One row per calendar entry per channel — the publishing robot''s work queue. Each delivery succeeds or fails independently; the parent entry''s status is derived from the set.';
comment on column public.marketing_deliveries.channel is
  'Denormalized from the account so a delivery still records where it went once the account row is unlinked.';
comment on column public.marketing_deliveries.external_ids is
  'Provider-side identifiers returned by the publish. Shape is the plugin''s business.';
comment on column public.marketing_deliveries.status is
  'pending | scheduled | publishing | published | failed | skipped. skipped means deliberately not sent, and is excluded from the parent entry''s derivation.';

-- The worker's claim query is `where status = ... and scheduled_at <= now()`.
-- This index is what makes it cheap; do not drop it.
create index if not exists marketing_deliveries_status_scheduled_at
  on public.marketing_deliveries (status, scheduled_at);

-- ─── 6. marketing_metrics ────────────────────────────────────────────────────
-- Per delivery per day. Created EMPTY. Nothing in the chassis writes it and
-- nothing may — the collector is a later chip, and a half-written metric is
-- worse than no metric.
--
-- Every counter is nullable on purpose: null means "not fetched", zero means
-- "the provider says zero". Collapsing those two would make a broken collector
-- look like a post nobody saw.
create table if not exists public.marketing_metrics (
  delivery_id uuid   not null references public.marketing_deliveries(id) on delete cascade,
  day         date   not null,

  reach       integer,
  saves       integer,
  comments    integer,
  clicks      integer,
  impressions integer,
  spend_cents bigint,
  conversions integer,

  primary key (delivery_id, day)
);

comment on table public.marketing_metrics is
  'Per delivery per day performance. Created empty; there is no writer in the chassis and there may not be one until the collector chip lands.';
comment on column public.marketing_metrics.day is
  'The metrics day as the provider reports it, not our local date arithmetic.';
comment on column public.marketing_metrics.spend_cents is
  'Money spent on a boost, in cents. Null for an organic delivery, which never spends.';

-- ─── 7. RLS ──────────────────────────────────────────────────────────────────
-- apply_grant_policies is ADDITIVE-ONLY: its predicate bottoms out in
-- effective_grant_level(), so a SELECT matching no policy returns ZERO ROWS
-- WITH NO ERROR. Until marketing.calendar and marketing.publish are registered
-- and granted, only admin (via its ROOT row) resolves them. That is the
-- intended posture, not an oversight.
alter table public.marketing_media            enable row level security;
alter table public.marketing_calendar_entries enable row level security;
alter table public.marketing_entry_media      enable row level security;
alter table public.marketing_deliveries       enable row level security;
alter table public.marketing_metrics          enable row level security;

select public.apply_grant_policies('marketing_media',            'marketing.calendar');
select public.apply_grant_policies('marketing_calendar_entries', 'marketing.calendar');
select public.apply_grant_policies('marketing_entry_media',      'marketing.calendar');
select public.apply_grant_policies('marketing_deliveries',       'marketing.publish');
select public.apply_grant_policies('marketing_metrics',          'marketing.publish');

-- marketing_connected_accounts gets RLS and NO POLICIES AT ALL. It holds live
-- publishing credentials, so the Data API surface for it is shut completely:
-- every consumer goes through createSupabaseAdminClient() behind a
-- requirePermission() guard, exactly as the finance tables do
-- (20261003090000_rls_close_authenticated_read_gaps.sql explains the intent at
-- length).
--
-- This is deliberately STRICTER than integration_connections, the nearest
-- precedent, which calls apply_grant_policies(..., 'finance.transactions') and
-- thereby lets a finance reader select its credentials column over the Data
-- API. Do not copy that part of it. DO NOT ADD A READ POLICY TO THIS TABLE
-- UNDER ANY CIRCUMSTANCES.
alter table public.marketing_connected_accounts enable row level security;

-- Belt to those suspenders. RLS with no policies already returns zero rows, but
-- it returns them SILENTLY, which is indistinguishable from an empty table. New
-- public tables inherit SELECT/INSERT/UPDATE/DELETE for anon and authenticated
-- from the stock Supabase default privileges (documented at the foot of
-- 20261003090000), so revoking them here makes the credential table fail loudly
-- instead of quietly — and makes a future policy added by accident inert.
-- Scoped to this one new table; the schema-wide revoke is still its own job.
-- service_role and the owner are unaffected, so the admin client still reads it.
revoke all on table public.marketing_connected_accounts from anon, authenticated;

-- ─── 8. Derived entry status ─────────────────────────────────────────────────
-- Entry status is derived from its deliveries. App code sets only
-- draft ↔ approved; every other value is this function's.
--
-- SECURITY DEFINER because the two tables sit under different scopes:
-- marketing_deliveries is marketing.publish and marketing_calendar_entries is
-- marketing.calendar. A publisher writing a delivery must not be able to leave
-- the parent entry's status stale just because they hold no calendar grant.
create or replace function public.marketing_entry_status_refresh()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_entry_ids   uuid[];
  r_entry       uuid;
  n_publishing  integer;
  n_failed      integer;
  n_active      integer;
  n_published   integer;
  v_status      text;
begin
  -- An update can move a delivery between entries, so both sides are refreshed.
  if tg_op = 'INSERT' then
    v_entry_ids := array[new.entry_id];
  elsif tg_op = 'DELETE' then
    v_entry_ids := array[old.entry_id];
  else
    v_entry_ids := array[old.entry_id, new.entry_id];
  end if;

  for r_entry in
    select distinct e from unnest(v_entry_ids) as t(e) where e is not null
  loop
    select
      count(*) filter (where d.status = 'publishing'),
      count(*) filter (where d.status = 'failed'),
      count(*) filter (where d.status <> 'skipped'),
      count(*) filter (where d.status = 'published')
      into n_publishing, n_failed, n_active, n_published
    from public.marketing_deliveries d
    where d.entry_id = r_entry;

    -- The ladder, first match wins.
    --
    -- publishing OUTRANKS failed on purpose: while any channel is still
    -- moving, the entry is still in progress; it only reads as failed once
    -- nothing is moving.
    if n_publishing > 0 then
      v_status := 'in_progress';
    elsif n_failed > 0 then
      v_status := 'failed';
    elsif n_active > 0 and n_published = n_active then
      v_status := 'done';
    elsif n_active > 0 then
      v_status := 'scheduled';
    else
      -- No deliveries, or every one of them skipped. There is nothing to
      -- derive from, so the entry keeps the status a PERSON last chose.
      -- Deleting the last delivery must return an approved entry to
      -- 'approved', not to some derived value.
      v_status := null;
    end if;

    if v_status is not null then
      update public.marketing_calendar_entries
         set status = v_status
       where id = r_entry
         and status is distinct from v_status;
    end if;
  end loop;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

comment on function public.marketing_entry_status_refresh() is
$c$Derives marketing_calendar_entries.status from that entry's marketing_deliveries. Fires AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW on marketing_deliveries.

The ladder, first match wins:
  1. any delivery publishing                                  -> in_progress
  2. else any delivery failed                                  -> failed
  3. else >=1 non-skipped delivery and all of them published    -> done
  4. else >=1 non-skipped delivery                              -> scheduled
  5. else (no deliveries, or all skipped)                       -> leave the entry alone

publishing outranks failed deliberately: while any channel is still moving the entry is still in progress, and it only reads as failed once nothing is moving.

Rule 5 never clobbers a human choice — draft and approved are the only statuses app code sets, and deleting the last delivery returns the entry to whichever of them a person last chose.$c$;

drop trigger if exists marketing_deliveries_entry_status on public.marketing_deliveries;
create trigger marketing_deliveries_entry_status
  after insert or update or delete on public.marketing_deliveries
  for each row execute function public.marketing_entry_status_refresh();

-- ─── 9. updated_at ───────────────────────────────────────────────────────────
-- public.update_updated_at() is the ONE canonical trigger, repo-wide
-- (20261001090005). Attached before insert or update, named <table>_updated_at
-- like every other table. Never set updated_at from app code.
drop trigger if exists marketing_connected_accounts_updated_at on public.marketing_connected_accounts;
create trigger marketing_connected_accounts_updated_at
  before insert or update on public.marketing_connected_accounts
  for each row execute function public.update_updated_at();

drop trigger if exists marketing_media_updated_at on public.marketing_media;
create trigger marketing_media_updated_at
  before insert or update on public.marketing_media
  for each row execute function public.update_updated_at();

drop trigger if exists marketing_calendar_entries_updated_at on public.marketing_calendar_entries;
create trigger marketing_calendar_entries_updated_at
  before insert or update on public.marketing_calendar_entries
  for each row execute function public.update_updated_at();

drop trigger if exists marketing_deliveries_updated_at on public.marketing_deliveries;
create trigger marketing_deliveries_updated_at
  before insert or update on public.marketing_deliveries
  for each row execute function public.update_updated_at();

-- marketing_entry_media and marketing_metrics carry no updated_at column, so
-- they get no trigger. Both are join/fact rows that are replaced, not edited.

-- ─── 10. Storage ─────────────────────────────────────────────────────────────
-- PUBLIC ON PURPOSE, and this is the one thing here that would be wrong to
-- copy from brand-assets. A channel like Instagram does not accept a file
-- upload from us; it accepts a URL and fetches the creative itself. A private
-- bucket therefore cannot publish at all.
--
-- This is the separate public bucket that 20260903_brand_assets_private.sql
-- explicitly reserved when it flipped brand-assets private ("When a public
-- marketing site exists it gets its OWN public bucket"). The two buckets stay
-- separate: brand-assets is the internal brand guide, marketing-media is what
-- the outside world is handed. Nothing here changes brand-assets.
--
-- Path convention is {yyyy}/{mm}/{uuid}.{ext}; a later chip implements the
-- upload, which follows the house order — upload to storage via the admin
-- client, THEN insert the marketing_media row.
insert into storage.buckets (id, name, public)
values ('marketing-media', 'marketing-media', true)
on conflict do nothing;

-- ─── rollback ────────────────────────────────────────────────────────────────
-- Everything this migration created, in dependency order. Verified by running
-- it inside a rolled-back transaction.
--
-- drop trigger if exists marketing_deliveries_entry_status         on public.marketing_deliveries;
-- drop trigger if exists marketing_deliveries_updated_at           on public.marketing_deliveries;
-- drop trigger if exists marketing_calendar_entries_updated_at     on public.marketing_calendar_entries;
-- drop trigger if exists marketing_media_updated_at                on public.marketing_media;
-- drop trigger if exists marketing_connected_accounts_updated_at   on public.marketing_connected_accounts;
--
-- drop function if exists public.marketing_entry_status_refresh();
--
-- drop table if exists public.marketing_metrics;
-- drop table if exists public.marketing_deliveries;
-- drop table if exists public.marketing_entry_media;
-- drop table if exists public.marketing_calendar_entries;
-- drop table if exists public.marketing_media;
-- drop table if exists public.marketing_connected_accounts;
--
-- -- storage.protect_delete() fires on storage.objects and storage.buckets and
-- -- rejects a bare DELETE with 42501. The escape hatch is a session setting,
-- -- and it is set LOCAL so it dies with the transaction.
-- set local storage.allow_delete_query = 'true';
-- delete from storage.objects where bucket_id = 'marketing-media';
-- delete from storage.buckets  where id       = 'marketing-media';
