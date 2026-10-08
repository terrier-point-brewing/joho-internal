-- Undo for floorplan mistakes: a mis-clicked kegging run, a move to the wrong tank.
--
-- A floorplan action (one POST to /api/production/transfers) writes one or more
-- batch_transfers rows and then fans out — tank assignments, the schedule, batch
-- status, cold storage, packaging stock. The schedule half is not reversible by
-- replaying it backwards: it overwrites volumes, cancels plans and claws back
-- future packaging. So an action is undone by RESTORING, not by reversing:
--
--   begin_transfer_action   snapshots the batch's schedule, tank assignments and
--                           status before the route writes anything
--   commit_transfer_action  snapshots the same rows afterwards and names the
--                           transfer rows the action wrote
--   undo_transfer_action    puts the "before" rows back, takes the finished goods
--                           and packaging materials back out by delta, and deletes
--                           the transfer rows — in one transaction
--
-- Undo is refused, with a reason a brewer can read, unless the batch still looks
-- exactly as the action left it: nothing later on the ledger, schedule and tanks
-- untouched, the finished goods still in cold storage and unshipped. Anything
-- else is a correction for a human, not an undo.
--
-- Shared stock (cold storage lots, packaging items) is reversed by delta rather
-- than snapshot, because other batches and taproom sales move it in between.
--
-- Conversions never get an action row, so they are never undoable here.

create table if not exists public.batch_transfer_actions (
  id            uuid        primary key default gen_random_uuid(),
  batch_id      uuid        not null references public.brew_batches(id) on delete cascade,
  transfer_type text,
  summary       text,
  transfer_ids  uuid[]      not null default '{}',
  -- Copies of the transfer rows, so an undone action still says what it was.
  transfers     jsonb,
  before_state  jsonb       not null,
  -- Null until the route finishes cleanly. An action that never committed is
  -- never undoable.
  after_state   jsonb,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  committed_at  timestamptz,
  undone_at     timestamptz,
  undone_by     uuid
);

create index if not exists batch_transfer_actions_batch_idx
  on public.batch_transfer_actions(batch_id, created_at desc);

alter table public.batch_transfer_actions enable row level security;

drop policy if exists "authenticated full access" on public.batch_transfer_actions;
create policy "authenticated full access" on public.batch_transfer_actions
  for all to authenticated using (true) with check (true);

drop policy if exists "partner users denied" on public.batch_transfer_actions;
create policy "partner users denied" on public.batch_transfer_actions
  as restrictive for all to public
  using ((select not public.is_partner_user()))
  with check ((select not public.is_partner_user()));

-- ── Snapshot ────────────────────────────────────────────────────────────────

create or replace function public.transfer_action_state(p_batch_id uuid)
returns jsonb
language sql
stable
set search_path to 'public'
as $function$
  select jsonb_build_object(
    'schedule', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.id)
        from public.batch_schedule_entries e where e.batch_id = p_batch_id), '[]'::jsonb),
    'assignments', coalesce((
      select jsonb_agg(to_jsonb(a) order by a.id)
        from public.batch_tank_assignments a where a.batch_id = p_batch_id), '[]'::jsonb),
    'status', (select b.status from public.brew_batches b where b.id = p_batch_id),
    'history_ids', coalesce((
      select jsonb_agg(h.id order by h.id)
        from public.batch_status_history h where h.batch_id = p_batch_id), '[]'::jsonb),
    'open_ingredient_commitment_ids', coalesce((
      select jsonb_agg(c.id order by c.id)
        from public.batch_ingredient_commitments c
       where c.batch_id = p_batch_id and c.released_at is null), '[]'::jsonb)
  );
$function$;

-- Rows compared for "has anything touched this since?" — updated_at is dropped
-- because a no-op write bumps it without changing anything.
create or replace function public.transfer_action_comparable(p_rows jsonb)
returns jsonb
language sql
immutable
set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(x - 'updated_at' order by x->>'id'), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x;
$function$;

create or replace function public.begin_transfer_action(p_batch_id uuid, p_created_by uuid default null)
returns uuid
language plpgsql
set search_path to 'public'
as $function$
declare
  v_id uuid;
begin
  insert into public.batch_transfer_actions(batch_id, before_state, created_by)
  values (p_batch_id, public.transfer_action_state(p_batch_id), p_created_by)
  returning id into v_id;
  return v_id;
end;
$function$;

create or replace function public.commit_transfer_action(
  p_action_id uuid, p_transfer_ids uuid[], p_transfer_type text, p_summary text)
returns void
language plpgsql
set search_path to 'public'
as $function$
begin
  update public.batch_transfer_actions a
     set transfer_ids  = p_transfer_ids,
         transfer_type = p_transfer_type,
         summary       = p_summary,
         transfers     = (select jsonb_agg(to_jsonb(t) order by t.transferred_at, t.id)
                            from public.batch_transfers t where t.id = any(p_transfer_ids)),
         after_state   = public.transfer_action_state(a.batch_id),
         committed_at  = now()
   where a.id = p_action_id and a.after_state is null;
end;
$function$;

-- ── Restore helper ──────────────────────────────────────────────────────────
-- Puts snapshot rows back into their table by id: existing rows are overwritten
-- column for column, rows deleted since are re-inserted. Column list is read
-- from the catalog so a column added later is restored too.

create or replace function public.transfer_action_restore_rows(p_table regclass, p_rows jsonb)
returns void
language plpgsql
set search_path to 'public'
as $function$
declare
  v_set text;
begin
  if p_rows is null or jsonb_array_length(p_rows) = 0 then
    return;
  end if;

  select string_agg(format('%I = r.%I', attname, attname), ', ')
    into v_set
    from pg_attribute
   where attrelid = p_table and attnum > 0 and not attisdropped
     and attgenerated = '' and attname not in ('id', 'updated_at');

  execute format(
    'update %s t set %s from jsonb_populate_recordset(null::%s, $1) r where t.id = r.id',
    p_table, v_set, p_table) using p_rows;

  execute format(
    'insert into %s select r.* from jsonb_populate_recordset(null::%s, $1) r
      where not exists (select 1 from %s t where t.id = r.id)',
    p_table, p_table, p_table) using p_rows;
end;
$function$;

-- ── Undo ────────────────────────────────────────────────────────────────────
-- p_dry_run = true runs every guard and changes nothing, so the floorplan can
-- say up front whether an action is still undoable and why not.
--
-- Refusals are raised with errcode P0001; the message is shown to the brewer.

create or replace function public.undo_transfer_action(
  p_action_id uuid, p_user_id uuid default null, p_dry_run boolean default false)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  v_action    public.batch_transfer_actions;
  v_current   jsonb;
  v_recipe_id uuid;
  v_last_at   timestamptz;
  v_found     int;
  v_tank_name text;
  v_line      record;
begin
  select * into v_action from public.batch_transfer_actions where id = p_action_id for update;
  if not found then
    raise exception 'That action no longer exists.' using errcode = 'P0001';
  end if;
  if v_action.undone_at is not null then
    raise exception 'This was already undone.' using errcode = 'P0001';
  end if;
  if v_action.after_state is null or cardinality(v_action.transfer_ids) = 0 then
    raise exception 'This action did not finish cleanly, so it cannot be undone automatically.' using errcode = 'P0001';
  end if;

  -- The ledger rows must all still be there…
  select count(*), max(transferred_at) into v_found, v_last_at
    from public.batch_transfers where id = any(v_action.transfer_ids);
  if v_found <> cardinality(v_action.transfer_ids) then
    raise exception 'This action''s transfer records have been changed since.' using errcode = 'P0001';
  end if;

  -- …and nothing may have happened to the batch after them.
  if exists (
    select 1 from public.batch_transfers t
     where (t.batch_id = v_action.batch_id or t.to_batch_id = v_action.batch_id)
       and t.transferred_at > v_last_at
       and not (t.id = any(v_action.transfer_ids))
  ) then
    raise exception 'Something else has been recorded for this batch since. Undo that first.' using errcode = 'P0001';
  end if;

  if exists (select 1 from public.export_transactions x where x.source_transfer_id = any(v_action.transfer_ids)) then
    raise exception 'Some of this run has already been shipped.' using errcode = 'P0001';
  end if;

  v_current := public.transfer_action_state(v_action.batch_id);

  if (v_current->>'status') is distinct from (v_action.after_state->>'status') then
    raise exception 'The batch status has changed since.' using errcode = 'P0001';
  end if;
  if public.transfer_action_comparable(v_current->'assignments')
     <> public.transfer_action_comparable(v_action.after_state->'assignments') then
    raise exception 'The batch''s tanks have changed since.' using errcode = 'P0001';
  end if;
  if public.transfer_action_comparable(v_current->'schedule')
     <> public.transfer_action_comparable(v_action.after_state->'schedule') then
    raise exception 'The batch''s schedule has been edited since.' using errcode = 'P0001';
  end if;

  -- A tank the batch goes back into must still be free.
  select e.name into v_tank_name
    from jsonb_to_recordset(v_action.before_state->'assignments') as b(tank_id uuid, released_at timestamptz)
    join public.batch_tank_assignments o
      on o.tank_id = b.tank_id and o.released_at is null and o.batch_id <> v_action.batch_id
    join public.equipment e on e.id = b.tank_id
   where b.released_at is null
   limit 1;
  if v_tank_name is not null then
    raise exception '% now holds another batch.', v_tank_name using errcode = 'P0001';
  end if;

  -- The finished goods must still be in cold storage to take back out.
  select b.recipe_id into v_recipe_id from public.brew_batches b where b.id = v_action.batch_id;
  for v_line in
    select t.variation_id, sum(t.quantity) as qty
      from public.batch_transfers t
     where t.id = any(v_action.transfer_ids) and t.variation_id is not null and coalesce(t.quantity, 0) <> 0
     group by t.variation_id
  loop
    if not exists (
      select 1 from public.cold_storage_inventory c
       where c.batch_id = v_action.batch_id and c.variation_id = v_line.variation_id
         and c.recipe_id is not distinct from v_recipe_id
         and c.quantity_on_hand >= v_line.qty
    ) then
      raise exception 'Some of this run has already left cold storage.' using errcode = 'P0001';
    end if;
  end loop;

  if p_dry_run then
    return jsonb_build_object('ok', true, 'batch_id', v_action.batch_id, 'recipe_id', v_recipe_id);
  end if;

  -- ── Finished goods back out of cold storage ───────────────────────────────
  for v_line in
    select t.variation_id, sum(t.quantity) as qty
      from public.batch_transfers t
     where t.id = any(v_action.transfer_ids) and t.variation_id is not null and coalesce(t.quantity, 0) <> 0
     group by t.variation_id
  loop
    update public.cold_storage_inventory c
       set quantity_on_hand = c.quantity_on_hand - v_line.qty
     where c.batch_id = v_action.batch_id and c.variation_id = v_line.variation_id
       and c.recipe_id is not distinct from v_recipe_id;
    -- A lot this action created and that is empty again never existed.
    delete from public.cold_storage_inventory c
     where c.batch_id = v_action.batch_id and c.variation_id = v_line.variation_id
       and c.recipe_id is not distinct from v_recipe_id
       and c.quantity_on_hand = 0 and c.created_at >= v_action.created_at;
  end loop;

  -- ── Packaging materials back on the shelf ─────────────────────────────────
  update public.packaging_items p
     set stock_quantity = p.stock_quantity - s.qty
    from (select packaging_item_id, sum(quantity) as qty
            from public.packaging_stock_adjustments
           where batch_transfer_id = any(v_action.transfer_ids)
           group by packaging_item_id) s
   where p.id = s.packaging_item_id;
  delete from public.packaging_stock_adjustments where batch_transfer_id = any(v_action.transfer_ids);

  -- ── Tanks ─────────────────────────────────────────────────────────────────
  -- Rows the action created go first, so re-opening the tank the batch came
  -- from cannot collide with one_active_assignment_per_tank.
  delete from public.batch_tank_assignments a
   where a.batch_id = v_action.batch_id
     and not exists (select 1 from jsonb_array_elements(v_action.before_state->'assignments') b
                      where (b->>'id')::uuid = a.id);
  perform public.transfer_action_restore_rows('public.batch_tank_assignments', v_action.before_state->'assignments');

  -- ── Schedule ──────────────────────────────────────────────────────────────
  perform public.transfer_action_restore_rows('public.batch_schedule_entries', v_action.before_state->'schedule');
  delete from public.batch_schedule_entries e
   where e.batch_id = v_action.batch_id
     and not exists (select 1 from jsonb_array_elements(v_action.before_state->'schedule') b
                      where (b->>'id')::uuid = e.id);

  -- ── Batch status ──────────────────────────────────────────────────────────
  update public.brew_batches b
     set status = v_action.before_state->>'status'
   where b.id = v_action.batch_id and b.status is distinct from (v_action.before_state->>'status');
  delete from public.batch_status_history h
   where h.batch_id = v_action.batch_id
     and not exists (select 1 from jsonb_array_elements_text(v_action.before_state->'history_ids') b
                      where b::uuid = h.id);
  -- Auto-completion released the batch's ingredient reservations; un-release
  -- exactly the ones that were open before.
  update public.batch_ingredient_commitments c
     set released_at = null
   where c.batch_id = v_action.batch_id and c.released_at is not null
     and exists (select 1 from jsonb_array_elements_text(v_action.before_state->'open_ingredient_commitment_ids') b
                  where b::uuid = c.id);

  -- ── The ledger rows themselves ────────────────────────────────────────────
  delete from public.batch_transfers where id = any(v_action.transfer_ids);

  update public.batch_transfer_actions
     set undone_at = now(), undone_by = p_user_id
   where id = p_action_id;

  return jsonb_build_object('ok', true, 'batch_id', v_action.batch_id, 'recipe_id', v_recipe_id);
end;
$function$;
