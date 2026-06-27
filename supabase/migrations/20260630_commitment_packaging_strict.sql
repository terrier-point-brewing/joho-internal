-- supabase/migrations/20260630_commitment_packaging_strict.sql
-- Spec 8: commitment_packaging_preferences moves from free-pick
-- packaging_item_id to strict variation_id, matching the
-- recipe_packaging_variations-declared-set principle Spec 10 established
-- for batch_transfers/cold_storage_inventory. No backfill — this table has
-- no cost-calc consumer today and live data is low-stakes (same precedent
-- Spec 10 set).

truncate table public.commitment_packaging_preferences;

alter table public.commitment_packaging_preferences
  drop column if exists packaging_item_id,
  add column if not exists variation_id uuid references public.packaging_variations(id) on delete restrict;

alter table public.commitment_packaging_preferences
  alter column variation_id set not null;
