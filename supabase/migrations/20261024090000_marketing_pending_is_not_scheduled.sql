-- A draft that knows where it is going is still a draft.
--
-- marketing_deliveries.status has a 'pending' value, and the whole point of it
-- is a delivery that EXISTS but has not been queued: a person has picked
-- Instagram and Facebook in Compose and saved the entry as a draft. Those two
-- rows are the only place that choice can live, because the channel selection
-- has nowhere else to be stored.
--
-- The original ladder counted every non-skipped delivery as active, so the
-- moment those rows appeared the trigger derived 'scheduled' and the draft
-- stopped reading as a draft. That made "save a draft with channels chosen"
-- impossible to express, and the API route had to refuse channels on anything
-- but an immediate publish to avoid it.
--
-- Fixed by adding one rung. Deliveries that are ALL pending derive nothing at
-- all — the entry keeps the status a person chose — which is the same answer
-- the ladder already gives for no deliveries and for all-skipped.
--
-- Deliberately NOT done: dropping 'pending' from the active count outright.
-- That would have been the smaller diff and it is wrong: an entry with one
-- published delivery and one still pending would have counted 1 of 1 published
-- and derived 'done' while a channel had not gone out yet. Partial progress
-- must read as 'scheduled', so 'pending' still counts as active everywhere
-- except the all-pending case.

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
      -- That is a draft with a plan, so derive nothing and leave the status
      -- the person chose. One pending delivery ALONGSIDE a queued or published
      -- one falls through to 'scheduled' below, because that entry really is
      -- underway.
      v_status := null;
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
$function$;

comment on function public.marketing_entry_status_refresh() is
  'Derives marketing_calendar_entries.status from its deliveries. Ladder, first match wins: any publishing -> in_progress; any failed -> failed; all active published -> done; all active pending -> derive nothing (a draft with its channels chosen); any active -> scheduled; none -> derive nothing. App code writes only draft and approved.';
