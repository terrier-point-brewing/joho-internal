-- Cold Storage + Transfer Log redesign (Spec 1/4): first-class inventory
-- table so Export Bay can query available finished goods grouped by
-- recipe + packaging variation, attributed to source batch, without
-- parsing batch_transfers jsonb. Also adds a blank-can flag so the
-- canning UI can require a label selection for blank-type cans.

create table if not exists public.cold_storage_inventory (
  id                  uuid primary key default gen_random_uuid(),
  batch_id            uuid not null references public.brew_batches(id) on delete cascade,
  recipe_id           uuid references public.recipes(id) on delete set null,
  packaging_item_id   uuid not null references public.packaging_items(id) on delete restrict,
  variant_label       text not null,
  quantity_on_hand    numeric not null default 0,
  source_transfer_id  uuid references public.batch_transfers(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists cold_storage_inventory_batch_idx
  on public.cold_storage_inventory(batch_id);
create index if not exists cold_storage_inventory_packaging_idx
  on public.cold_storage_inventory(packaging_item_id);
create unique index if not exists cold_storage_inventory_batch_variant_idx
  on public.cold_storage_inventory(batch_id, packaging_item_id, variant_label);

alter table public.packaging_items
  add column if not exists requires_label boolean not null default false;
