-- Receive purchased (guest) beer into cold storage.
--
-- cold_storage_inventory is keyed on batch_id NOT NULL, so beer bought from
-- another brewery has always needed a placeholder brew_batches row. The three
-- times it happened (20260712, 20260715, 20261208) it was a hand-written data
-- migration — and the first two created placeholder "complete" batches with a
-- real volume_bbl, which inflated produced volume and the excise record.
--
-- This gives the placeholder a name. A `purchased` batch:
--   * has volume_bbl 0 and turns 0 (the derive trigger enforces it), so it
--     seeds nothing into the volume ledger, yields, or allocations;
--   * is excluded by the batch list and by every produced-volume reader in
--     app code (grep `source`, "purchased");
--   * stamps every export_transactions row drawn from it as
--     `is_tax_paid_purchase`, so TTB / NC DOR removal reads and the invoice
--     excise writer skip it. The beer was tax-paid by the brewery that made
--     it; removing it from our cold room is not a removal from our bond.
--
-- One purchased batch per recipe, found-or-created by the receive route, with
-- every delivery logged in beer_receipts (supplier, cost, date).

-- ── 1. brew_batches.source ─────────────────────────────────────────────────
alter table public.brew_batches
  add column if not exists source text not null default 'brewed';

alter table public.brew_batches
  drop constraint if exists brew_batches_source_check;
alter table public.brew_batches
  add constraint brew_batches_source_check check (source in ('brewed', 'purchased'));

comment on column public.brew_batches.source is
  'brewed = made here (volume derived from turns). purchased = tax-paid beer bought from another brewery: a placeholder that only exists so cold_storage_inventory has a batch to hang the lot on. volume_bbl 0, turns 0, never on the excise record.';

create index if not exists brew_batches_purchased_recipe_idx
  on public.brew_batches(recipe_id) where source = 'purchased';

-- A purchased batch never saw the brewhouse. Its volume is 0 and it has no
-- turns — the trigger owns both so no client can type a volume onto it.
create or replace function public.brew_batches_derive_volume()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.source = 'purchased' then
    new.volume_bbl := 0;
    new.turns := 0;
    new.turns_completed := 0;
  elsif new.converted_from_batch_id is null then
    new.volume_bbl := 20 * greatest(coalesce(new.turns, 1), 1);
  end if;
  return new;
end;
$$;

drop trigger if exists brew_batches_derive_volume on public.brew_batches;
create trigger brew_batches_derive_volume
  before insert or update of volume_bbl, turns, source on public.brew_batches
  for each row execute function public.brew_batches_derive_volume();

-- ── 2. beer_receipts — the intake journal ──────────────────────────────────
create table if not exists public.beer_receipts (
  id            uuid        primary key default gen_random_uuid(),
  batch_id      uuid        not null references public.brew_batches(id) on delete restrict,
  recipe_id     uuid        not null references public.recipes(id) on delete restrict,
  variation_id  uuid        not null references public.packaging_variations(id) on delete restrict,
  quantity      numeric     not null check (quantity > 0),
  supplier      text,
  cost_cents    bigint      check (cost_cents is null or cost_cents >= 0),
  received_on   date        not null default current_date,
  note          text,
  created_by    uuid        references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);

comment on table public.beer_receipts is
  'Purchased (guest) beer received into cold storage. One row per delivery; the units land on the recipe''s purchased placeholder batch in cold_storage_inventory. The purchase cost itself is booked by the expense feed (Ramp/Chase); cost_cents here is the operator''s record for valuation.';

create index if not exists beer_receipts_batch_idx on public.beer_receipts(batch_id, received_on desc);

alter table public.beer_receipts enable row level security;

drop policy if exists "authenticated full access" on public.beer_receipts;
create policy "authenticated full access" on public.beer_receipts
  for all to authenticated using (true) with check (true);

drop policy if exists "partner users denied" on public.beer_receipts;
create policy "partner users denied" on public.beer_receipts
  as restrictive for all to public
  using ((select not public.is_partner_user()))
  with check ((select not public.is_partner_user()));

-- ── 3. export_transactions.is_tax_paid_purchase ────────────────────────────
-- Stamped by trigger from the batch, never by the writer, so every path that
-- drains cold storage (taproom sync, Export Bay, Configure Taps, refunds)
-- gets it right without knowing the rule exists.
alter table public.export_transactions
  add column if not exists is_tax_paid_purchase boolean not null default false;

comment on column public.export_transactions.is_tax_paid_purchase is
  'The batch this row drew from is a purchased placeholder (brew_batches.source = purchased). The beer was tax-paid by its producer, so this row is NOT a removal on the TTB or NC DOR return and carries no excise. Set by trigger.';

create index if not exists export_transactions_tax_paid_purchase_idx
  on public.export_transactions(created_at) where is_tax_paid_purchase;

create or replace function public.export_transactions_stamp_tax_paid_purchase()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.batch_id is null then
    new.is_tax_paid_purchase := false;
  else
    select (b.source = 'purchased') into new.is_tax_paid_purchase
      from public.brew_batches b where b.id = new.batch_id;
    new.is_tax_paid_purchase := coalesce(new.is_tax_paid_purchase, false);
  end if;
  return new;
end;
$$;

drop trigger if exists export_transactions_stamp_tax_paid_purchase on public.export_transactions;
create trigger export_transactions_stamp_tax_paid_purchase
  before insert or update of batch_id on public.export_transactions
  for each row execute function public.export_transactions_stamp_tax_paid_purchase();
