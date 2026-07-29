-- Correct the mis-entered packaging runs on B-035 (Wiggo!, batch c02b77c8).
--
-- WHAT WENT WRONG
-- B-035 put 18 BBL into brite tank 33 (transfer d30363c4, 20 BBL brewed − 2 BBL
-- shrinkage). Four packaging runs were then recorded, but the operator entered
-- the FIRST line of each pair twice instead of entering the intended second
-- line:
--
--   14fbb97f  canning  2026-07-22 18:57  33 × Can Case      2.3952 BBL  ← correct
--   d25f8ea8  canning  2026-07-22 18:59  33 × Can Case      2.3952 BBL  ← should be 3 × loose Can
--   f9031150  kegging  2026-07-23 19:14  18 × 1/2 Keg       9.0000 BBL  ← correct
--   56f2cb09  kegging  2026-07-23 19:14  18 × 1/2 Keg       9.0000 BBL  ← should be 24 × 1/6 Keg
--
-- Recorded draw was 22.79 BBL against 18 BBL available, so batch_exhaustion
-- reported remaining_bbl = −4.79 and checkAndCompleteBatch force-completed the
-- batch. Cold storage inherited the doubled counts (66 cases, 36 half kegs).
--
-- CONFIRMED PHYSICAL TRUTH (operator, 2026-07-29)
--   18 × 1/2 Keg, 24 × 1/6 Keg, 33 × Can Case, 3 × loose 12oz Can
--
-- The 33 cases is the CANNING RUN output, not today's shelf count: on 2026-07-25
-- a genuine Square taproom sale (sqsale:ZLBNOX4CWRZSC24OFRP3HCNP) broke 2 cases
-- into 8 six-packs and sold 6. That sale and its two cold_storage_breaks rows are
-- real synced history and are deliberately left intact, so cases land at 31 with
-- the 2 leftover six-packs untouched.
--
-- Volume reconciliation (1 BBL = 3968 fl oz):
--   33 × Can Case (288)  =  9,504 fl oz
--    3 × loose Can (12)  =     36 fl oz
--   18 × 1/2 Keg (1984)  = 35,712 fl oz
--   24 × 1/6 Keg (661)   = 15,864 fl oz
--                          ------------
--   packaged             = 61,116 fl oz = 15.4022 BBL
--   tank 33 held 18 BBL  = 71,424 fl oz
--   residual             = 10,308 fl oz =  2.5978 BBL  → recorded as packaging
--                                                        shrinkage on 56f2cb09
--
-- Recording the residual as shrinkage (operator-confirmed: tank 33 is physically
-- empty) drains tank 33 in the derived ledger (computeTankVolumes) and lands
-- batch_exhaustion.remaining_bbl on 0, so 'complete' stays correct. Step 3
-- derives that shrinkage from the stored volumes rather than hardcoding it, so
-- the tank balances to zero by construction.
--
-- WHAT IS NOT TOUCHED
--   * 14fbb97f / f9031150 and all their packaging adjustments — these were right.
--   * batch_allocations — batch-wide channel %, not per-transfer.
--   * batch_tank_assignments — every row is already released, and the corrected
--     runs drain tank 33 completely, so no assignment needs reopening.
--   * brew_batches.status / batch_status_history — 'complete' remains correct
--     (is_exhausted tests remaining <= 0.001).
--   * cold_storage_breaks + export_transactions 50c9a815 (the 07-25 taproom sale).
--   * The 2-unit six-pack cold-storage row 672ee85c.
--   * batch_schedule_entries stamping — both canning runs really did happen on
--     07-22 and both kegging runs on 07-23; only their volumes were wrong.
--
-- NOTE ON NEGATIVE PACKAGING STOCK: several packaging_items already sit negative
-- (12oz Blank −1584, 1/2 Keg −103, 1/6 Keg −151, label −1584) because receipts
-- are under-recorded brewery-wide. This migration moves each of them by the
-- correct delta; it does not try to fix those pre-existing baselines. The 1/6 Keg
-- draw of 24 takes that item to −175, consistent with existing practice (the
-- 20260807 B-038 correction accepted the same for labels).
--
-- IDEMPOTENT: every statement is guarded on the pre-correction value, so a
-- re-run is a no-op. Stock movements are derived from the guarded adjustment-row
-- writes (the reversible ledger for packaging_items.stock_quantity), never
-- applied blind.

begin;

-- ---------------------------------------------------------------------------
-- 1. Canning run #2: 33 × Can Case → 3 × loose 12oz Can.
-- ---------------------------------------------------------------------------
update batch_transfers
   set variation_id = 'd5d4a968-4070-4ca5-9e64-22d9c41483c2',  -- CBC Wiggo! IPA - 12oz Labeled Can
       quantity     = 3,
       volume_bbl   = 36::numeric / 3968,                      -- 3 × 12 fl oz
       notes        = 'Corrected 2026-07-29: mis-entered as a duplicate 33 × Can Case; actual run was 3 × loose 12oz Can.'
 where id = 'd25f8ea8-ccd6-4d17-a262-4a584b99069e'
   and variation_id = '7a231209-eec5-4a46-bb58-63c2d4c01fdc'
   and quantity = 33;

-- ---------------------------------------------------------------------------
-- 2. Kegging run #2: 18 × 1/2 Keg → 24 × 1/6 Keg.
-- ---------------------------------------------------------------------------
update batch_transfers
   set variation_id = '4ddbce98-7970-44c7-9dc2-97d5e489509c',  -- 1/6 Keg
       quantity     = 24,
       volume_bbl   = 15864::numeric / 3968,                   -- 24 × 661 fl oz
       notes        = 'Corrected 2026-07-29: mis-entered as a duplicate 18 × 1/2 Keg; actual run was 24 × 1/6 Keg. Carries the batch''s packaging shrinkage.'
 where id = '56f2cb09-9354-479a-8a91-ecaa551eba59'
   and variation_id = 'ac4f3b17-d827-4e45-a823-ae80eb4dbbbc'
   and quantity = 18;

-- ---------------------------------------------------------------------------
-- 3. Park the unpackaged residual as shrinkage on the final kegging run, derived
--    from the now-corrected volumes so tank 33 drains to exactly zero.
--    (Tank 33 = 931d2282; it received 18 BBL and is drained only by these four
--    packaging transfers, whose other three shrinkage values are 0.)
-- ---------------------------------------------------------------------------
update batch_transfers t
   set shrinkage_bbl = 18 - (
         select sum(x.volume_bbl)
           from batch_transfers x
          where x.batch_id     = 'c02b77c8-5666-4619-8d1e-d03aa9d88b33'
            and x.from_tank_id = '931d2282-29bb-4840-8a2b-7e2565b56ab5'
       )
 where t.id = '56f2cb09-9354-479a-8a91-ecaa551eba59'
   and t.shrinkage_bbl = 0;

-- ---------------------------------------------------------------------------
-- 4. Canning run #2 packaging draw: 792 cans/lids/labels → 3 each; the tray and
--    paktech components do not exist on a loose-can variation, so those two
--    adjustment rows are removed entirely and their stock restored.
-- ---------------------------------------------------------------------------
with adj as (
  update packaging_stock_adjustments
     set quantity = -3,
         note     = note || ' [corrected 2026-07-29: 33 cases → 3 loose cans]'
   where batch_transfer_id = 'd25f8ea8-ccd6-4d17-a262-4a584b99069e'
     and quantity = -792
  returning packaging_item_id, 789::numeric as delta   -- (-3) − (-792)
)
update packaging_items pi
   set stock_quantity = pi.stock_quantity + a.delta
  from adj a
 where pi.id = a.packaging_item_id;

with adj as (
  delete from packaging_stock_adjustments
   where batch_transfer_id = 'd25f8ea8-ccd6-4d17-a262-4a584b99069e'
     and packaging_item_id in (
       '2faf1e44-79a7-461b-9168-7f93d31bc7d9',  -- Blank Tray      (−33)
       '8ac8c228-e0b7-41d9-bb71-52031d634150'   -- 6-Pack (Black)  (−132)
     )
  returning packaging_item_id, quantity
)
update packaging_items pi
   set stock_quantity = pi.stock_quantity - a.quantity   -- subtracting a negative restocks
  from adj a
 where pi.id = a.packaging_item_id;

-- ---------------------------------------------------------------------------
-- 5. Kegging run #2 packaging draw: 18 × 1/2 Keg → 24 × 1/6 Keg.
-- ---------------------------------------------------------------------------
with moved as (
  update packaging_stock_adjustments
     set packaging_item_id = '64d0ddbb-a0e3-40a3-b671-e9cedb89fd7a',  -- 1/6 Keg
         quantity          = -24,
         note              = 'Kegging (container) — batch c02b77c8-5666-4619-8d1e-d03aa9d88b33 [corrected 2026-07-29: 18 × 1/2 Keg → 24 × 1/6 Keg]'
   where batch_transfer_id = '56f2cb09-9354-479a-8a91-ecaa551eba59'
     and packaging_item_id = 'b1acfd81-0397-4c85-93c9-638a0f346373'   -- 1/2 Keg
     and quantity = -18
  returning id
),
restock_half_keg as (
  update packaging_items
     set stock_quantity = stock_quantity + 18
   where id = 'b1acfd81-0397-4c85-93c9-638a0f346373'
     and exists (select 1 from moved)
  returning id
)
update packaging_items
   set stock_quantity = stock_quantity - 24
 where id = '64d0ddbb-a0e3-40a3-b671-e9cedb89fd7a'
   and exists (select 1 from moved);

-- ---------------------------------------------------------------------------
-- 6. Cold storage. Rows are keyed (batch_id, variation_id) and AGGREGATE across
--    every transfer, and source_transfer_id is only "last transfer that touched
--    this row" — so these must be re-pointed and re-quantified, not deleted.
--      Can Case : 66 produced − 2 broken for the 07-25 sale − ... = 64 → 31
--      1/2 Keg  : 36 → 18
--      + new rows for the two variations the corrected runs actually produced.
-- ---------------------------------------------------------------------------
update cold_storage_inventory
   set quantity_on_hand   = 31,   -- 33 canned − 2 broken into six-packs on 07-25
       source_transfer_id = '14fbb97f-274c-44b4-9960-8a61256ee581',
       updated_at         = now()
 where id = '989c5c42-827f-47a8-8fe9-78b778e427d6'
   and quantity_on_hand = 64;

update cold_storage_inventory
   set quantity_on_hand   = 18,
       source_transfer_id = 'f9031150-767d-4503-a8ea-24d027baa1e9',
       updated_at         = now()
 where id = '526b5ce3-4c92-4721-9504-2310fb35289c'
   and quantity_on_hand = 36;

insert into cold_storage_inventory
  (batch_id, recipe_id, variation_id, quantity_on_hand, source_transfer_id)
select 'c02b77c8-5666-4619-8d1e-d03aa9d88b33',
       '89dd0d4b-4a2b-4d87-afbd-0167ded96549',
       'd5d4a968-4070-4ca5-9e64-22d9c41483c2',   -- CBC Wiggo! IPA - 12oz Labeled Can
       3,
       'd25f8ea8-ccd6-4d17-a262-4a584b99069e'
 where not exists (
   select 1 from cold_storage_inventory
    where batch_id     = 'c02b77c8-5666-4619-8d1e-d03aa9d88b33'
      and variation_id = 'd5d4a968-4070-4ca5-9e64-22d9c41483c2'
 );

insert into cold_storage_inventory
  (batch_id, recipe_id, variation_id, quantity_on_hand, source_transfer_id)
select 'c02b77c8-5666-4619-8d1e-d03aa9d88b33',
       '89dd0d4b-4a2b-4d87-afbd-0167ded96549',
       '4ddbce98-7970-44c7-9dc2-97d5e489509c',   -- 1/6 Keg
       24,
       '56f2cb09-9354-479a-8a91-ecaa551eba59'
 where not exists (
   select 1 from cold_storage_inventory
    where batch_id     = 'c02b77c8-5666-4619-8d1e-d03aa9d88b33'
      and variation_id = '4ddbce98-7970-44c7-9dc2-97d5e489509c'
 );

-- ---------------------------------------------------------------------------
-- 7. Re-point the two schedule entries the corrected runs stamped at their real
--    volumes. Both runs genuinely happened on the dates recorded, so the
--    actual_start / actual_end stamps stay; only volume_bbl was wrong.
-- ---------------------------------------------------------------------------
update batch_schedule_entries
   set volume_bbl = round(36::numeric / 3968, 3),      -- 0.009
       updated_at = now()
 where id = '2ea7ec2b-dab3-4494-9c33-43b3e4d755c0'     -- "Unscheduled additional canning"
   and volume_bbl = 2.395;

update batch_schedule_entries
   set volume_bbl = round(15864::numeric / 3968, 3),   -- 3.998
       updated_at = now()
 where id = '86e00bf7-b094-48ac-8344-4ccb3a1ddcd4'     -- "Unscheduled additional kegging"
   and volume_bbl = 9.000;

commit;

-- ---------------------------------------------------------------------------
-- Post-apply verification (expected results):
--
--   select kegged_bbl, canned_bbl, shrinkage_bbl, consumed_bbl,
--          remaining_bbl, is_exhausted
--     from batch_exhaustion
--    where batch_id = 'c02b77c8-5666-4619-8d1e-d03aa9d88b33';
--   → kegged 12.9980 | canned 2.4042 | shrinkage 4.5978 | consumed 20.0000
--     remaining 0.0000 | is_exhausted true
--
--   select pv.name, csi.quantity_on_hand
--     from cold_storage_inventory csi
--     join packaging_variations pv on pv.id = csi.variation_id
--    where csi.batch_id = 'c02b77c8-5666-4619-8d1e-d03aa9d88b33';
--   → 1/2 Keg 18 | 1/6 Keg 24 | Can Case 31 | loose Can 3 | 6-Pack 2
--
--   Tank 33 (931d2282) must derive to 0 BBL remaining in computeTankVolumes.
-- ---------------------------------------------------------------------------
