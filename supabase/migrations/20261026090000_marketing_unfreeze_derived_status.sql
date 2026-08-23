-- An entry with nothing in flight must not read as in progress.
--
-- The ladder's last rung — "there is nothing to derive from, so leave the
-- status alone" — is only safe while the status it declines to overwrite is one
-- a PERSON set. Once the trigger has moved an entry to a derived value,
-- declining to derive freezes it there:
--
--   approved                        -> person
--   one delivery, publishing        -> in_progress   (derived)
--   that delivery becomes skipped   -> in_progress   (frozen, nothing in flight)
--
-- Reproduced against the database twice, once through the real worker. Today it
-- needs an account unlinked mid-publish, which is rare. It stops being rare the
-- moment a person can press Disconnect on a live channel — a button that
-- already exists — and there is no path back out of the frozen state.
--
-- The fix: when there is nothing to derive, an entry sitting on a DERIVED
-- status falls back to 'approved'; one sitting on 'draft' or 'approved' is left
-- exactly as it is, which is what that rung was always for.
--
-- Why 'approved' is the right floor. An entry only ever reaches a derived
-- status by having had a delivery queued, and queueing is the approval act —
-- Post now writes 'approved' as it goes. A draft never derives at all: its
-- deliveries are 'pending', and the rung added in 20261024090000 already
-- declines to derive from those. So no draft can arrive here, and anything that
-- can is something a person put on the queue.
--
-- If that assumption ever stops holding — say a future path queues an entry
-- without approving it — the honest fix is a separate column recording the last
-- person-set status, with `status` becoming purely derived. That is a bigger
-- change than this bug is worth today, and it is written down here so whoever
-- needs it does not have to rediscover the reasoning.
--
-- Note this also corrects a case 20261022090000's own gate recorded as passing:
-- deleting the last delivery from a published entry left it reading 'done',
-- when that rung's stated intent was always to return the entry to the status a
-- person last chose.

create or replace function public.marketing_entry_status_refresh()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $function$
declare
  v_entry_ids   uuid[];
  r_entry       uuid;
  n_publishing  integer;
  n_failed      integer;
  n_active      integer;
  n_published   integer;
  n_pending     integer;
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
      count(*) filter (where d.status = 'published'),
      count(*) filter (where d.status = 'pending')
      into n_publishing, n_failed, n_active, n_published, n_pending
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
    elsif n_active > 0 and n_pending = n_active then
      -- Every delivery is pending: the channels are chosen, nothing is queued.
      -- A draft with a plan. Derive nothing.
      v_status := null;
    elsif n_active > 0 then
      v_status := 'scheduled';
    else
      -- No deliveries, or every one of them skipped.
      v_status := null;
    end if;

    if v_status is not null then
      update public.marketing_calendar_entries
         set status = v_status
       where id = r_entry
         and status is distinct from v_status;
    else
      -- Nothing to derive from. A person's own status stays untouched; a
      -- derived one is released, because the thing it described is over.
      update public.marketing_calendar_entries
         set status = 'approved'
       where id = r_entry
         and status in ('scheduled', 'in_progress', 'done', 'failed');
    end if;
  end loop;

  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

comment on function public.marketing_entry_status_refresh() is
  'Derives marketing_calendar_entries.status from its deliveries. Ladder, first match wins: any publishing -> in_progress; any failed -> failed; all active published -> done; all active pending -> derive nothing (a draft with its channels chosen); any active -> scheduled. When there is nothing to derive from, a draft/approved entry is left alone and an entry on a derived status falls back to approved, so nothing freezes with no delivery in flight. App code writes only draft and approved.';
