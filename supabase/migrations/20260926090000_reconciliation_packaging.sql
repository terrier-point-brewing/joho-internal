-- Kegs can now be pushed to Square too, so the reconciliation journal has to say
-- which packaging a row is about.
--
-- The count columns keep their `_cans` names to avoid rewriting every reader for
-- a rename; they hold a unit count in the packaging's own unit — loose cans for
-- 'can', whole kegs for 'keg'. The comments below are the contract.

alter table square_inventory_reconciliations
  add column if not exists packaging text not null default 'can'
    check (packaging in ('can', 'keg'));

comment on column square_inventory_reconciliations.packaging is
  'Which packaging this correction was for. Decides the unit of cold_storage_cans / square_cans_before.';

comment on column square_inventory_reconciliations.cold_storage_cans is
  'Cold storage on hand at correction time, in the packaging''s own unit: loose cans for packaging=can, whole kegs for packaging=keg.';

comment on column square_inventory_reconciliations.square_cans_before is
  'Square''s count immediately BEFORE the write, same unit as cold_storage_cans. A row exists only when the write was read back and confirmed.';

-- The drift view and the cron summary both read "recent corrections, newest
-- first", usually filtered to one packaging.
create index if not exists square_inventory_reconciliations_packaging_occurred_idx
  on square_inventory_reconciliations (packaging, occurred_at desc);
