-- Cold-storage transforms: let a build-up through, without letting beer through.
--
-- WHAT WAS BROKEN. The 20260927 constraint reads
--   to_units * to_volume_fl_oz <= from_units * from_volume_fl_oz
-- and it was written with only one direction in mind: cracking a big unit into
-- small ones. A transform runs the other way too — combining 3 x 1/6 Keg into
-- 1 x 1/2 Keg is the same journal row with from/to swapped, and the schema was
-- always direction-agnostic (from_variation_id / to_variation_id say nothing
-- about which is bigger). That build-up is how an operator gets stock into the
-- shape a phantom-export reconcile insists on, since reconcilePhantom only
-- accepts a keg of the exact size that was booked and never recomputes excise.
--
-- And the constraint rejected it. Stored volumes: 1/2 Keg 1984, 1/4 Keg 992,
-- 1/6 Keg 661. Three sixtels is 1983 and a half keg is 1984, so the check failed
-- by ONE fluid ounce on a transform that is physically exact.
--
-- WHY THAT OUNCE ISN'T BEER. It is our own rounding. A 1/2 bbl is 15.5 gal =
-- 1984 fl oz exactly and a 1/4 bbl is 992 exactly, but a 1/6 bbl is 31/6 gal =
-- 661.33 fl oz and total_volume_fl_oz is recorded in whole ounces throughout, so
-- we store 661. Three REAL sixtels are 1984 fl oz; three STORED sixtels are
-- 1983. The gap is in the record, not in the tank.
--
-- WHICH COMBINATIONS THIS AFFECTS — not just 3 x 1/6. The sixtel is the only
-- inexact container in the whole set (every can, 4-pack, 6-pack, case, 1/4 and
-- 1/2 keg is a whole number of fl oz), and it is understated by exactly 1/3 fl
-- oz. So any transform whose SOURCE is sixtels loses from_units/3 fl oz of
-- headroom, and the shortfall grows without bound as the counts do:
--     3 x 1/6 -> 1 x 1/2   short by 1 fl oz
--     3 x 1/6 -> 2 x 1/4   short by 1 fl oz
--     6 x 1/6 -> 2 x 1/2   short by 2 fl oz
--    30 x 1/6 -> 10 x 1/2  short by 10 fl oz
-- Breaking down INTO sixtels never trips it — an understated sixtel only makes
-- the output look smaller, which the check already allows.
--
-- WHY THE SLACK IS PER UNIT AND NOT A FLAT NUMBER. Because the error above
-- accumulates with units, a flat tolerance would pass 3 x 1/6 -> 1 x 1/2 and
-- reject 30 x 1/6 -> 10 x 1/2: the identical physical operation, ten times over.
-- Half a fluid ounce per unit on BOTH sides is the honest bound implied by
-- storing volumes as whole ounces — that is the most a single stored figure can
-- differ from its container, and either side can be the rounded one. Sized from
-- the storage format rather than from today's sizes, so a future variation whose
-- true volume isn't a whole ounce needs no special case.
--
-- Deliberately NOT reusing SWAP_VOLUME_TOLERANCE_FL_OZ's 5. That constant asks
-- "is this the same size keg?" of a single unit, where the sizes are 331 fl oz
-- apart and a generous flat number is safe. Here the number is a licence to
-- create beer, so it is sized to the smallest thing that covers the rounding and
-- nothing else. Both descend from the same fact (whole-fl-oz storage); only one
-- of them has to scale.
--
-- WHAT STAYS TRUE. A transform still cannot create beer. What it may now create
-- is at most (from_units + to_units) * 0.5 fl oz of ARITHMETIC — a hundredth of
-- a pint on the motivating case — and only because we chose to record containers
-- in whole ounces. Every genuine over-creation is still rejected outright:
-- 4 x 1/6 -> 2 x 1/2 asks for 3968 out of 2644 and is refused by 1324 fl oz,
-- nowhere near a 3 fl oz allowance. The right permanent fix is decimal volumes
-- on packaging_variations; until then this is the honest approximation.
--
-- WHERE ELSE THIS LIVES. previewTransform() in
-- lib/production/coldStorageTransform.ts computes the identical inequality so an
-- operator sees the problem while typing. The DB is still the enforcer; if the
-- two ever disagree, the UI will offer something this constraint refuses. They
-- are written to the same algebra on purpose — change both together.
--
-- The journal insert is still the LAST statement inside
-- apply_cold_storage_transform (unchanged by this migration, and untouched since
-- 20260927), so a violation continues to roll back the decrement and the credit
-- with it. This migration only widens the check; it does not move where it fires.

alter table public.cold_storage_transforms
  drop constraint if exists cold_storage_transforms_never_creates_volume;

alter table public.cold_storage_transforms
  add constraint cold_storage_transforms_never_creates_volume
  check (
    to_units * to_volume_fl_oz
      <= from_units * from_volume_fl_oz + (from_units + to_units) * 0.5
  );

comment on constraint cold_storage_transforms_never_creates_volume
  on public.cold_storage_transforms is
  'A transform may lose volume, never create it. The (from_units + to_units) * 0.5 term is rounding slack, not licence: total_volume_fl_oz is stored in whole ounces and a 1/6 bbl is really 661.33, so 3 x 1/6 -> 1 x 1/2 reads as 1983 vs 1984 despite being exact. Half an ounce per unit is the worst a whole-ounce figure can misstate its container, and it is per unit because the error accumulates. Mirrored in previewTransform().';
