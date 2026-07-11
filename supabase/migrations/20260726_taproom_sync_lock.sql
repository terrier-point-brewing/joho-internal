-- Cooperative lease lock for serializing background reconciles that use a
-- non-atomic read-then-write pattern — specifically the taproom-consumption sync.
--
-- Why a table and not pg_advisory_lock: PostgREST hands each supabase-js call a
-- fresh connection, so a session-level advisory lock can't be held across the
-- sync's many round-trips. This lease is a row that lives across the whole run.
--
-- The bug it fixes: the Square webhook fires the full taproom sync on every
-- order.* event, so a single Draft Restock's event burst spawned ~6 concurrent
-- syncs. Each read "0 already recorded" for the swap's source_ref (none had
-- committed yet) and wrote its own duplicate export_transactions row, over-
-- draining cold storage. The sync now claims this lease first and skips if held.

create table if not exists public.sync_locks (
  job         text        primary key,
  locked_at   timestamptz not null default now(),
  expires_at  timestamptz not null
);

comment on table public.sync_locks is
  'Lease locks serializing background syncs (see try_acquire_sync_lock). One row per job; expires_at bounds a crashed holder so a wedged lock self-clears.';

-- Service-role only: the admin client (which bypasses RLS) is the sole caller.
-- Enable RLS with no policies so anon/authenticated get no access at all.
alter table public.sync_locks enable row level security;

-- Try to claim `p_job` for `p_ttl_seconds`. Returns true when the lock was free —
-- either no row exists, or the existing lease already expired (a holder that
-- crashed without releasing). Returns false when a live holder still owns it.
-- Atomic by construction: INSERT ... ON CONFLICT is a single statement that takes
-- a row lock, so of N concurrent callers exactly one can win.
create or replace function public.try_acquire_sync_lock(p_job text, p_ttl_seconds integer)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_got boolean;
begin
  insert into public.sync_locks (job, locked_at, expires_at)
  values (p_job, now(), now() + make_interval(secs => p_ttl_seconds))
  on conflict (job) do update
    set locked_at = now(), expires_at = now() + make_interval(secs => p_ttl_seconds)
    where public.sync_locks.expires_at < now()   -- only steal an expired lease
  returning true into v_got;
  return coalesce(v_got, false);                 -- no row updated ⇒ live lock held
end;
$$;

-- Release the lease. Safe to call unconditionally (e.g. from a finally); a no-op
-- if the row is already gone.
create or replace function public.release_sync_lock(p_job text)
returns void
language sql
set search_path = public
as $$
  delete from public.sync_locks where job = p_job;
$$;

revoke execute on function public.try_acquire_sync_lock(text, integer) from public, anon, authenticated;
revoke execute on function public.release_sync_lock(text)              from public, anon, authenticated;
grant  execute on function public.try_acquire_sync_lock(text, integer) to service_role;
grant  execute on function public.release_sync_lock(text)              to service_role;
