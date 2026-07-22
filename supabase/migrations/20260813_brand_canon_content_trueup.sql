-- Brand canon content true-up.
--
-- The Phase 0 seed (migration 20260808) published a canon whose voice/mission/
-- naming fields were fabricated and whose Narrative layer (values, never list,
-- the chop, chassis, illustration law, hard rules) was missing. The corrected,
-- founder-approved content now lives in lib/brand/seedCanon.ts.
--
-- getCanon() reads the published DB row first and only falls back to seedCanon
-- when there is none. So we remove the stale v1.0 rows (the fabricated seed and
-- any draft derived from it); getCanon() then serves the corrected seedCanon.
-- The founder can re-publish from the canon editor to create a fresh DB-backed
-- v1.1 (the editor seeds its draft from seedCanon when no published row exists).
--
-- Safe: only removes the v1.0 seed rows. Any founder-authored version (1.1+)
-- with real content is untouched. Idempotent.
--
-- Human-gated (do not auto-apply).

delete from public.brand_canon_versions where version_label = '1.0';
