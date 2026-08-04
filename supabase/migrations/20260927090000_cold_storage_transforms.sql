-- Cold-storage transforms: generalise the pack break-down journal to cover kegs.
--
-- WHY THIS ISN'T A NEW TABLE. cold_storage_breaks (20260717) already journals
-- exactly this operation shape: one parent unit held in cold storage becomes N
-- child units of a different packaging variation, same batch, same recipe,
-- nothing entering or leaving the cold room. Cracking a 1/2 keg into sixtels is
-- the same event as cracking a case into packs. A second table would mean every
-- audit surface has to union two shapes that mean the same thing.
--
-- WHAT KEGS ADD. Cans conserve exactly -- 1 case (24 x 16oz) becomes 4 six-packs
-- and not a drop is lost. Kegs do not: a 1/2 keg is 1984 fl oz and a 1/6 is 661,
-- so three sixtels is a near-perfect 1983, but foam and line loss routinely mean
-- you actually fill two. That lost volume is real beer and has to be recorded,
-- not silently absent. So the journal grows a shrinkage column and the invariant
-- relaxes from "conserves units" to "never CREATES volume".
--
-- WHY THE VOLUMES ARE SNAPSHOT ONTO THE ROW rather than joined from
-- packaging_variations at read time: an audit journal has to stay true after
-- someone edits a variation's volume, and with both volumes on the row the
-- shrinkage decomposes without a join -- the row proves its own loss.
--
-- WHAT THIS DELIBERATELY DOES NOT TOUCH. A transform happens AFTER a batch has
-- been packaged out and closed. It is a finished-goods event, not a production
-- event, so it must not write back into the production ledger:
--   * no batch_transfers row      -- would rewrite a closed batch's history and
--                                    inflate produced volume
--   * no export_transactions row  -- nothing left the building
--   * no volumeLedger involvement -- computeLocationBreakdown reports what a
--                                    batch PUT INTO cold storage at packaging.
--                                    Shipping and taproom pours already don't
--                                    write back to it (see shipmentWriter, which
--                                    only reads batch_transfers); a transform is
--                                    no different. The divergence between
--                                    batch_transfers and cold_storage_inventory
--                                    is sanctioned house policy -- see the
--                                    20260712 reconciliation's "accepted
--                                    cosmetic gap vs. batch_transfers".
--   * no GL entry -- cold storage carries no dollar value on the balance sheet
--                    (there is no finished-goods account; 1300 is Prepaid
--                    Expenses, 1310 is Security Deposits), so the shrinkage has
--                    zero finance impact and is purely physical.
--
-- It DOES restate Square, though — pushInventoryToSquare has covered mapped keg
-- SKUs since 20260926, so the route calls triggerSquarePush exactly as the ship
-- routes do. (The other direction stays cans-only: reconcileSquareCanInventory
-- pushes loose-can counts and kegs are not in that path.)
--
-- batch_id is still carried, but for ATTRIBUTION only (which batch is in that
-- sixtel, for recall and age) -- never for volume math.

-- ── Rename the table and its indexes ────────────────────────────────────────
alter table public.cold_storage_breaks rename to cold_storage_transforms;

alter index if exists cold_storage_breaks_batch_idx      rename to cold_storage_transforms_batch_idx;
alter index if exists cold_storage_breaks_source_ref_idx rename to cold_storage_transforms_source_ref_idx;

-- Constraints do NOT follow a table rename, and PostgREST resolves embedded
-- selects by FK CONSTRAINT NAME — the adjustments route asks for
-- `packaging_variations!cold_storage_transforms_from_variation_id_fkey`. Leaving
-- these on their old names would work at the DB level but break that join, so
-- rename them too and keep the whole object graph consistent.
alter table public.cold_storage_transforms
  rename constraint cold_storage_breaks_pkey to cold_storage_transforms_pkey;
alter table public.cold_storage_transforms
  rename constraint cold_storage_breaks_batch_id_fkey to cold_storage_transforms_batch_id_fkey;
alter table public.cold_storage_transforms
  rename constraint cold_storage_breaks_recipe_id_fkey to cold_storage_transforms_recipe_id_fkey;
alter table public.cold_storage_transforms
  rename constraint cold_storage_breaks_from_variation_id_fkey to cold_storage_transforms_from_variation_id_fkey;
alter table public.cold_storage_transforms
  rename constraint cold_storage_breaks_to_variation_id_fkey to cold_storage_transforms_to_variation_id_fkey;

-- RLS policies follow the table through a rename (they attach to the OID), so
-- the existing "authenticated full access" grants carry over untouched.

-- ── Volume snapshots + provenance ──────────────────────────────────────────
-- Defaults are temporary scaffolding so the NOT NULL holds while the 22 existing
-- can-break rows are backfilled; dropped at the end of this migration so a
-- future insert can never quietly record a zero-volume transform.
alter table public.cold_storage_transforms
  add column if not exists from_volume_fl_oz numeric not null default 0,
  add column if not exists to_volume_fl_oz   numeric not null default 0,
  add column if not exists note              text,
  add column if not exists created_by        uuid references auth.users(id) on delete set null;

comment on column public.cold_storage_transforms.from_volume_fl_oz is
  'Volume of ONE parent unit, snapshot at transform time. Snapshot, not joined, so the journal stays true if the variation is later edited.';
comment on column public.cold_storage_transforms.to_volume_fl_oz is
  'Volume of ONE child unit, snapshot at transform time.';
comment on column public.cold_storage_transforms.note is
  'Operator''s reason, for manual transforms. Null for automatic can breaks.';
comment on column public.cold_storage_transforms.created_by is
  'Who recorded a manual transform. Null for automatic can breaks (no human actor).';
comment on column public.cold_storage_transforms.source_ref is
  'Triggering sale''s idempotency/trace key for automatic can breaks. Null for manual transforms, where created_by + note carry the who and why instead.';

-- ── Backfill the 22 existing can-break rows from their variations ───────────
-- Cans conserve, so every backfilled row computes to exactly 0 shrinkage.
update public.cold_storage_transforms t
   set from_volume_fl_oz = fv.total_volume_fl_oz,
       to_volume_fl_oz   = tv.total_volume_fl_oz
  from public.packaging_variations fv, public.packaging_variations tv
 where fv.id = t.from_variation_id
   and tv.id = t.to_variation_id
   and (t.from_volume_fl_oz = 0 or t.to_volume_fl_oz = 0);

alter table public.cold_storage_transforms
  alter column from_volume_fl_oz drop default,
  alter column to_volume_fl_oz   drop default;

-- ── Shrinkage: derived, never entered ──────────────────────────────────────
-- Generated so it can never disagree with the units and volumes beside it. This
-- is the ONLY record anywhere in the app of beer lost to a transform -- the
-- batch ledger deliberately never sees it (see the header).
alter table public.cold_storage_transforms
  add column if not exists shrinkage_fl_oz numeric
    generated always as (from_units * from_volume_fl_oz - to_units * to_volume_fl_oz) stored;

comment on column public.cold_storage_transforms.shrinkage_fl_oz is
  'Volume lost in the transform, derived. Always 0 for can breaks (cans conserve); positive for kegs. The app''s only record of this loss.';

-- ── The invariant: a transform may LOSE volume, never create it ────────────
-- The whole safety story in one line, enforced by the database rather than by
-- app code someone has to remember to write. 1 x 1/2 keg -> 3 x 1/6 (1983 <=
-- 1984) passes; -> 4 x 1/6 (2644) is rejected. Because the journal insert is the
-- last statement inside apply_cold_storage_transform, a violation rolls back the
-- inventory writes with it.
alter table public.cold_storage_transforms
  drop constraint if exists cold_storage_transforms_never_creates_volume;
alter table public.cold_storage_transforms
  add constraint cold_storage_transforms_never_creates_volume
  check (to_units * to_volume_fl_oz <= from_units * from_volume_fl_oz);

alter table public.cold_storage_transforms
  drop constraint if exists cold_storage_transforms_positive_units;
alter table public.cold_storage_transforms
  add constraint cold_storage_transforms_positive_units
  check (from_units > 0 and to_units > 0);

-- Newest-first reads for the Export > Adjustments tab.
create index if not exists cold_storage_transforms_occurred_idx
  on public.cold_storage_transforms (occurred_at desc);

-- ── The atomic writer ──────────────────────────────────────────────────────
-- applyBreakDown.ts does decrement -> credit -> journal as three sequential
-- round-trips and its own comment flags that as a known weakness it wanted to
-- fix with "a plpgsql RPC (single atomic statement)". For a background can break
-- a partial failure merely under-counts, which is safe. A keg transform is a
-- human clicking once: it has to be all-or-nothing. This is that RPC, and the
-- can path can adopt it later and delete its warning.
create or replace function public.apply_cold_storage_transform(
  p_lot_id          uuid,
  p_to_variation_id uuid,
  p_from_units      numeric,
  p_to_units        numeric,
  p_note            text default null,
  p_source_ref      text default null
)
returns public.cold_storage_transforms
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_lot      public.cold_storage_inventory;
  v_from_vol numeric;
  v_to_vol   numeric;
  v_remaining numeric;
  v_result   public.cold_storage_transforms;
  -- Matches the DUST epsilon in lib/production/applyBreakDown.ts.
  c_dust constant numeric := 0.0001;
begin
  if p_from_units is null or p_from_units <= 0 then
    raise exception 'from_units must be positive' using errcode = '22023';
  end if;
  if p_to_units is null or p_to_units <= 0 then
    raise exception 'to_units must be positive' using errcode = '22023';
  end if;
  if p_to_variation_id is null then
    raise exception 'to_variation_id is required' using errcode = '22023';
  end if;

  -- Lock the source lot for the duration of the transaction so two concurrent
  -- transforms can't both spend the same keg.
  select * into v_lot from public.cold_storage_inventory where id = p_lot_id for update;
  if not found then
    raise exception 'cold storage lot % not found', p_lot_id using errcode = 'P0002';
  end if;

  if v_lot.variation_id = p_to_variation_id then
    raise exception 'a transform must change packaging variation' using errcode = '22023';
  end if;

  if v_lot.quantity_on_hand < p_from_units - c_dust then
    raise exception 'lot holds % unit(s), cannot transform %',
      v_lot.quantity_on_hand, p_from_units using errcode = '22023';
  end if;

  select total_volume_fl_oz into v_from_vol
    from public.packaging_variations where id = v_lot.variation_id;
  select total_volume_fl_oz into v_to_vol
    from public.packaging_variations where id = p_to_variation_id;
  if v_from_vol is null then
    raise exception 'source variation % has no volume', v_lot.variation_id using errcode = '22023';
  end if;
  if v_to_vol is null then
    raise exception 'target variation % not found or has no volume', p_to_variation_id using errcode = '22023';
  end if;

  -- Decrement the parent, deleting the row once it holds only dust (matches how
  -- coldStorageDepletion and applyBreakDown already retire an emptied lot).
  v_remaining := v_lot.quantity_on_hand - p_from_units;
  if v_remaining <= c_dust then
    delete from public.cold_storage_inventory where id = v_lot.id;
  else
    update public.cold_storage_inventory
       set quantity_on_hand = v_remaining, updated_at = now()
     where id = v_lot.id;
  end if;

  -- Credit the children onto the SAME batch, so attribution survives the
  -- transform. (batch_id, variation_id) is unique, so this is one statement.
  insert into public.cold_storage_inventory (batch_id, recipe_id, variation_id, quantity_on_hand)
  values (v_lot.batch_id, v_lot.recipe_id, p_to_variation_id, p_to_units)
  on conflict (batch_id, variation_id) do update
    set quantity_on_hand = public.cold_storage_inventory.quantity_on_hand + excluded.quantity_on_hand,
        updated_at       = now();

  -- Journal it. The never-creates-volume constraint fires HERE, which is why
  -- this statement is last: a bad count rolls back the two writes above with it.
  insert into public.cold_storage_transforms (
    batch_id, recipe_id, from_variation_id, to_variation_id,
    from_units, to_units, from_volume_fl_oz, to_volume_fl_oz,
    note, source_ref, created_by
  ) values (
    v_lot.batch_id, v_lot.recipe_id, v_lot.variation_id, p_to_variation_id,
    p_from_units, p_to_units, v_from_vol, v_to_vol,
    nullif(btrim(coalesce(p_note, '')), ''), p_source_ref, auth.uid()
  ) returning * into v_result;

  return v_result;
end;
$$;

comment on function public.apply_cold_storage_transform is
  'Atomically reformat one cold-storage lot into another packaging variation of the same batch: decrement parent, credit children, journal the loss. All-or-nothing.';

grant execute on function public.apply_cold_storage_transform(uuid, uuid, numeric, numeric, text, text) to authenticated;
