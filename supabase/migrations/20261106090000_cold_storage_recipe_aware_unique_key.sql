-- Cold storage is keyed by batch + variation + RECIPE, and now the index says so.
--
-- cold_storage_inventory_batch_variation_idx has been UNIQUE on
-- (batch_id, variation_id) since 20260628_strict_packaging_rekey.sql, when one
-- batch was one beer and that pair really was identity.
--
-- An in-keg conversion broke that assumption. The same batch can fill 1/6 kegs
-- of Carolina Mule and 1/6 kegs of Transfusion Pilsner on the same day, and the
-- application already keys on all three columns — upsertColdStorageInventory in
-- app/api/production/transfers/route.ts looks up by batch + variation + recipe,
-- with a comment saying precisely why. The index was never widened to match, so
-- the database still enforced the old grain.
--
-- What that cost, in prod: on 2026-08-31 a conversion was recorded against
-- B-057 (kegging, 3 x 1/6 Keg, packaged_as Transfusion Pilsner). The transfer
-- row was written. The cold-storage upsert found no Transfusion row, tried to
-- INSERT one, and hit this index because B-057 already held Carolina Mule in the
-- same variation. The route wraps that block in a try/catch that logs and
-- continues, so the run reported success while three kegs of beer never entered
-- inventory. The physical count found them on the shelf.
--
-- Any conversion into a variation its parent batch already holds fails the same
-- way, silently. That is a standing hole in the ledger, not a one-off.
--
-- NULLS NOT DISTINCT (PG 15+; prod is 17.6) so a NULL recipe_id still collides
-- with another NULL rather than allowing unlimited orphaned duplicates. There
-- are no NULL recipe_id rows today; this keeps it that way if one appears.

drop index if exists public.cold_storage_inventory_batch_variation_idx;

create unique index if not exists cold_storage_inventory_batch_variation_recipe_idx
  on public.cold_storage_inventory (batch_id, variation_id, recipe_id)
  nulls not distinct;
