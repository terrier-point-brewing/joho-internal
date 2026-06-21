-- Export Transaction model + batch completion (Spec 2a/4): replaces
-- batch_exports with a per-packaging-variant export_transactions table
-- (status lifecycle + shipment grouping), replaces brew_batches.status's
-- 'archived' value with 'complete' (triggered by full export, not
-- cold-storage arrival), and replaces hardcoded excise tax constants with
-- a user-configurable excise_tax_rates table.

-- ── 1. Recompute existing 'archived' batches before the value is repurposed ──
-- 'archived' previously fired the moment product arrived in cold storage,
-- before any of it was exported. Re-evaluate actual exhaustion: a batch
-- that's truly fully exported becomes 'complete'; one that just arrived in
-- cold storage but hasn't been exported yet goes back to 'packaging'.
update public.brew_batches b
set status = case when be.is_exhausted then 'complete' else 'packaging' end
from public.batch_exhaustion be
where be.batch_id = b.id
  and b.status = 'archived';

-- ── 2. Remove the cold_storage → archived auto-transition ────────────────────
create or replace function public.record_batch_transfer(
  p_batch_id       uuid,
  p_from_tank_id   uuid,
  p_to_tank_id     uuid,
  p_volume_bbl     numeric,
  p_shrinkage_bbl  numeric  default 0,
  p_transfer_type  text     default 'transfer',
  p_notes          text     default null,
  p_kegging_detail jsonb    default null,
  p_canning_detail jsonb    default null,
  p_created_by     uuid     default null
) returns public.batch_transfers language plpgsql as $$
declare
  v_transfer      public.batch_transfers;
  v_dest_type     text;
  v_new_status    text;
  v_cur_status    text;
  v_unconstrained text[] := array['kegging','canning','cold_storage','backlog','loading_bay','export_bay'];
begin
  insert into public.batch_transfers(
    batch_id, from_tank_id, to_tank_id, volume_bbl, shrinkage_bbl,
    transfer_type, notes, kegging_detail, canning_detail, created_by
  ) values (
    p_batch_id, p_from_tank_id, p_to_tank_id, p_volume_bbl, coalesce(p_shrinkage_bbl, 0),
    coalesce(p_transfer_type, 'transfer'), p_notes, p_kegging_detail, p_canning_detail,
    p_created_by
  ) returning * into v_transfer;

  update public.batch_tank_assignments
     set released_at = now()
   where batch_id = p_batch_id and released_at is null;

  if p_to_tank_id is not null then
    select type into v_dest_type from public.equipment where id = p_to_tank_id;
    if v_dest_type is not null then
      v_new_status := case v_dest_type
        when 'brewhouse'    then 'brewing'
        when 'fermenter'    then 'fermenting'
        when 'brite'        then 'conditioning'
        when 'kegging'      then 'packaging'
        when 'canning'      then 'packaging'
        else null
      end;
      if not (v_dest_type = any(v_unconstrained)) then
        if exists (select 1 from public.batch_tank_assignments where tank_id = p_to_tank_id and released_at is null) then
          raise exception 'Destination tank is already occupied';
        end if;
        insert into public.batch_tank_assignments(batch_id, tank_id, notes)
          values (p_batch_id, p_to_tank_id, null);
      end if;
      if v_new_status is not null then
        select status into v_cur_status from public.brew_batches where id = p_batch_id;
        if v_cur_status is distinct from v_new_status then
          update public.brew_batches set status = v_new_status where id = p_batch_id;
          insert into public.batch_status_history(batch_id, status, note)
            values (p_batch_id, v_new_status, 'Auto: transferred to ' || coalesce(p_transfer_type, 'transfer'));
        end if;
      end if;
    end if;
  end if;

  return v_transfer;
end;
$$;

-- ── 3. excise_tax_rates ───────────────────────────────────────────────────────
create table public.excise_tax_rates (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  receiving_party text,
  unit            text not null check (unit in ('bbl', 'gallon')),
  rate_usd        numeric not null,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

insert into public.excise_tax_rates (name, receiving_party, unit, rate_usd) values
  ('Federal Excise Tax', 'TTB', 'bbl', 3.50),
  ('NC Excise Tax', 'NC Department of Revenue', 'gallon', 0.62);

-- ── 4. export_transactions ────────────────────────────────────────────────────
create table public.export_transactions (
  id                      uuid primary key default gen_random_uuid(),
  shipment_id             uuid not null,
  batch_id                uuid not null references public.brew_batches(id) on delete cascade,
  recipe_id               uuid references public.recipes(id) on delete set null,
  allocation_id           uuid references public.batch_allocations(id) on delete set null,
  packaging_item_id       uuid not null references public.packaging_items(id) on delete restrict,
  variant_label           text not null,
  quantity                numeric not null,
  volume_bbl              numeric not null,
  channel                 text not null check (channel in ('taproom', 'distribution', 'contract_brewing')),
  recipient_id            uuid references public.contract_brewing_partners(id) on delete set null,
  recipient_name          text,
  status                  text not null default 'invoice_required' check (status in ('invoice_required', 'unpaid', 'paid')),
  total_excise_tax_usd    numeric not null default 0,
  source_transfer_id      uuid references public.batch_transfers(id) on delete set null,
  notes                   text,
  created_at              timestamptz not null default now()
);

create index export_transactions_shipment_idx on public.export_transactions(shipment_id);
create index export_transactions_batch_idx on public.export_transactions(batch_id);
create index export_transactions_allocation_idx on public.export_transactions(allocation_id);
create index export_transactions_status_idx on public.export_transactions(status);

-- ── 5. export_transaction_taxes ───────────────────────────────────────────────
create table public.export_transaction_taxes (
  id                    uuid primary key default gen_random_uuid(),
  export_transaction_id uuid not null references public.export_transactions(id) on delete cascade,
  excise_tax_rate_id    uuid references public.excise_tax_rates(id) on delete set null,
  tax_name              text not null,
  unit                  text not null,
  rate_usd              numeric not null,
  amount_usd            numeric not null,
  created_at            timestamptz not null default now()
);

create index export_transaction_taxes_export_idx on public.export_transaction_taxes(export_transaction_id);

-- ── 6. Drop batch_exports (green-field/test-only data, confirmed no backfill needed) ──
drop table if exists public.batch_exports;
