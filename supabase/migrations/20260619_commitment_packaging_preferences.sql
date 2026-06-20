-- Commitments can carry multiple packaging preferences (e.g. half + sixth
-- kegs, or kegs + cans on the same commitment), so move from the single
-- packaging_item_id/packaging_qty columns on commitments into a related
-- table. Stored as real rows (not a JSON blob) so other planning features
-- can join against specific packaging items later.

create table if not exists public.commitment_packaging_preferences (
  id                uuid        primary key default gen_random_uuid(),
  commitment_id     uuid        not null references public.commitments(id) on delete cascade,
  packaging_item_id uuid        not null references public.packaging_items(id) on delete restrict,
  qty               numeric     not null check (qty > 0),
  created_at        timestamptz not null default now()
);

create index if not exists cpp_commitment_idx on public.commitment_packaging_preferences(commitment_id);

-- Backfill from the existing single-value columns.
insert into public.commitment_packaging_preferences (commitment_id, packaging_item_id, qty)
select id, packaging_item_id, packaging_qty
from public.commitments
where packaging_item_id is not null and packaging_qty is not null and packaging_qty > 0;

alter table public.commitments drop column if exists packaging_item_id;
alter table public.commitments drop column if exists packaging_qty;
