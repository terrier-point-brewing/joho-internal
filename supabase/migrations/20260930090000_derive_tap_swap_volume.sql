-- One keg, one capacity: stop storing the full-keg recount target on the tap.
--
-- THE BUG. All 14 rows of tap_assignments carried swap_volume_fl_oz = 660 while
-- every one of them pointed at packaging_variations "1/6 Keg", which is 661. The
-- same physical sixtel therefore reported two different capacities depending on
-- which screen you were on, and Square's draft on-hand was reset to 660 on every
-- restock recount -- one ounce per keg silently unaccounted.
--
-- WHERE 660 CAME FROM. Not hand-entry in the current UI: the recount-target
-- field has been read-only, derived from the chosen variation, since #103. It is
-- a fossil. 20260705_draft_swap_per_tap.sql moved swap_volume_fl_oz across from
-- taproom_recipe_settings, where it HAD been a free number, and nothing has
-- re-derived it since. It survived because the editor round-tripped it: opening
-- the tap panel loaded the stored value into form state and saving wrote it
-- straight back, so the number refreshed only if someone happened to re-pick the
-- keg from the dropdown. PUT /api/taproom/tap-config took the client's figure
-- without ever checking it against swap_variation_id sitting right beside it.
--
-- THE FIX IS TO DELETE THE COPY, NOT TO CORRECT IT. Setting these 14 rows to 661
-- fixes today and leaves the divergence mechanism in place for tomorrow. The
-- recount target is not an independent fact -- it is the swap keg's own coded
-- volume, and packaging_variations already holds that. So the column goes, and
-- every read joins through swap_variation_id instead. The API still returns
-- `swap_volume_fl_oz` on the wire (flattened from the join), so no caller has to
-- change; only the storage disappears. A stale value has nowhere left to live.
--
-- WHY THIS TABLE AND NOT THE OTHERS. tap_assignments is CONFIGURATION: it says
-- what is set up right now, so it should always speak for the current state of
-- the variation it points at. The volume columns on draft_swap_shrinkage,
-- tap_swap_transitions and cold_storage_transforms are JOURNALS -- they record
-- what was measured or moved at a moment in time, and they keep their own
-- snapshots on purpose, exactly as 20260927090000 argued for the transform
-- journal ("an audit journal has to stay true after someone edits a variation's
-- volume"). Config derives; journals snapshot. This migration only touches the
-- config side.
--
-- WHAT IS DELIBERATELY LEFT ALONE. All 34 existing draft_swap_shrinkage rows
-- have full_fl_oz = 660, because 660 is genuinely the basis those keg balances
-- were measured against, and unaccounted_fl_oz was derived from it. Restating
-- them would rewrite recorded measurements and every shrinkage percentage on the
-- Draft Stats report. They stay as they are; new rows pick up 661 automatically
-- now that the recount target derives. Rows written before this migration read
-- 660 for that reason, not by mistake.

alter table public.tap_assignments drop column if exists swap_volume_fl_oz;

comment on column public.tap_assignments.swap_variation_id is
  'Cold-storage packaging variation drained when this tap is swapped. Its total_volume_fl_oz IS the full-keg recount target -- derived through this FK, never stored here, so the tap can never disagree with the keg it names.';
