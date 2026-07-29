-- Release ingredient commitments held by batches that have already left planning.
--
-- A commitment RESERVES stock for a batch that has not been brewed yet. Once a
-- batch reaches the brewhouse the reservation is supposed to be released and the
-- stock physically deducted instead (see releaseCommitments in
-- lib/production/commitments.ts). Batches that were backfilled, or that moved on
-- before that release existed, kept their reservations forever — so their
-- already-consumed ingredients were counted a SECOND time against every batch
-- still in planning.
--
-- Measured on prod 2026-07-29: 45 unreleased rows across B-033 (fermenting) and
-- B-041/B-042/B-044/B-045/B-047 (complete). B-045 alone was still reserving
-- 770 lb Prairie Select, 35 lb Mosaic and 2 L Wy1318 from an April brew, which
-- is what made B-034 report "9 ingredients short" and blocked its brewhouse
-- assignment despite the inventory being there.
--
-- getShortfalls now filters on the owning batch's status, so this migration is a
-- data cleanup rather than the fix itself: it stops the dead rows accumulating
-- and keeps the table honest for anything that queries it directly.

update public.batch_ingredient_commitments c
   set released_at = now()
  from public.brew_batches b
 where c.batch_id = b.id
   and c.released_at is null
   and b.status not in ('planning', 'backlog');
