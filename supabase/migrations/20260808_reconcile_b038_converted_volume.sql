-- Reconcile B-038 (Pumpkin Ale) headline volume to what its conversion delivered.
--
-- B-038 was born by converting from parent batch eb5b0b93. The conversion
-- transfer recorded 24.5 BBL delivered + 0.5 BBL shrinkage — so only 24.5 BBL
-- physically arrived in brite tank 33. But the pre-planned target batch was
-- created with volume_bbl = converted_volume_bbl = 25 (the planned amount), and
-- that stale headline was never reconciled to the delivered volume.
--
-- Effect of the mismatch: once B-038 was fully packaged, its Volume Breakdown
-- reconciled to the delivered 24.5 BBL but was compared against the nominal 25,
-- leaving a permanent 0.50 BBL "unbalanced" phantom (= the conversion shrinkage).
--
-- This sets both volumes to the actually-delivered 24.5 BBL. B-038 has no
-- ingredient commitments (0 rows — converted batches carry no grain bill), so no
-- commitment refresh is needed. Allocations are percentage-based and unaffected.
--
-- The going-forward code fix (reconcileConvertedBatchVolume, applied on every
-- sanctioned conversion execution) prevents new conversion-born batches from
-- landing in this state; this migration corrects the one existing row.
--
-- Idempotent: guarded on the stale (25, 25) state, so a re-run is a no-op.

begin;

update brew_batches
   set volume_bbl           = 24.5,
       converted_volume_bbl = 24.5
 where id = '22a9408a-c4e1-4169-8978-b4b06fb1b86f'
   and volume_bbl = 25
   and converted_volume_bbl = 25;

commit;
