-- Cold-storage pack break-down journal.
--
-- A "break" is an INTERNAL cold-storage reformatting, not a shipment: a sealed
-- case is cracked into packs, or a pack into singles, so a taproom single sale
-- can be fulfilled from packaged stock. Nothing leaves cold storage and no
-- packaging is consumed (that cost was booked at production), so a break must
-- NOT land in export_transactions (outbound ledger) or batch_transfers
-- (production inbound — would inflate produced-volume). It gets its own journal.
--
-- Invariant: every break conserves cans — from_units * (to_units/from_units)
-- cans in == cans out. to_units = cans_per(from_variation) / cans_per(to_variation)
-- target-tier units produced per broken parent. Breaks are one level at a time
-- (case→pack→single) and stay within a single batch (a cracked B-040 case yields
-- B-040 packs), preserving batch attribution.

create table if not exists public.cold_storage_breaks (
  id                 uuid primary key default gen_random_uuid(),
  batch_id           uuid not null references public.brew_batches(id) on delete cascade,
  recipe_id          uuid references public.recipes(id) on delete set null,
  from_variation_id  uuid not null references public.packaging_variations(id) on delete restrict,
  to_variation_id    uuid not null references public.packaging_variations(id) on delete restrict,
  from_units         numeric not null,   -- parent units cracked (1 per break op)
  to_units           numeric not null,   -- child units produced per op (cans_from/cans_to)
  source_ref         text,               -- triggering sale's idempotency/trace key; null for manual breaks
  occurred_at        timestamptz not null default now(),
  created_at         timestamptz not null default now()
);

create index if not exists cold_storage_breaks_batch_idx
  on public.cold_storage_breaks(batch_id);
create index if not exists cold_storage_breaks_source_ref_idx
  on public.cold_storage_breaks(source_ref)
  where source_ref is not null;
