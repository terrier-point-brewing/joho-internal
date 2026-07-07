-- Drop the two ad-hoc backup tables left behind by the 2026-07-04 batch-conversion
-- work (schema audit, Tier-0). They are point-in-time snapshots of brew_batches and
-- cold_storage_inventory; no application code references either and nothing FKs into
-- them.

drop table if exists public.brew_batches_bak_20260704;
drop table if exists public.cold_storage_inventory_bak_20260704;
