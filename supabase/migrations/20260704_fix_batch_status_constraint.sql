-- Fix batch status lifecycle:
-- • Drop oldest record_batch_transfer overload (cold_storage → 'archived')
-- • Replace constraint to allow 'complete', remove 'archived'/'ready_to_package'
-- • Migrate any remaining 'archived' batches to the correct terminal status

-- ── 1. Drop the old overload that still auto-sets cold_storage → 'archived' ────
-- The two newer overloads (with p_created_by) already handle this correctly.
DROP FUNCTION IF EXISTS public.record_batch_transfer(
  uuid, uuid, uuid, numeric, numeric, text, text, jsonb, jsonb
);

-- ── 2. Fix the status CHECK constraint ──────────────────────────────────────────
ALTER TABLE public.brew_batches DROP CONSTRAINT brew_batches_status_check;
ALTER TABLE public.brew_batches ADD CONSTRAINT brew_batches_status_check
  CHECK (status IN ('planning', 'brewing', 'fermenting', 'conditioning', 'packaging', 'complete'));

-- ── 3. Migrate 'archived' batches + record history in one CTE ───────────────────
WITH migrated AS (
  UPDATE public.brew_batches b
  SET status = CASE WHEN be.is_exhausted THEN 'complete' ELSE 'packaging' END
  FROM public.batch_exhaustion be
  WHERE be.batch_id = b.id
    AND b.status = 'archived'
  RETURNING b.id, (CASE WHEN be.is_exhausted THEN 'complete' ELSE 'packaging' END) AS new_status
)
INSERT INTO public.batch_status_history (batch_id, status, note)
SELECT id, new_status, 'Migration: corrected from legacy archived status'
FROM migrated;
