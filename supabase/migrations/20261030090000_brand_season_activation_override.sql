-- ============================================================================
-- Season activation: the override, recorded on the row.
--
-- Chip 3 of the season kit. Chips 1 and 2 gave a season somewhere to live and a
-- board that says what it is still missing; this adds the moment that reads
-- that list and refuses.
--
-- A kit is COMPLETE when it has a ground, a chop glyph, at least one motif, at
-- least one example and a voice note. That rule lives in ONE place —
-- `kitGaps()` in lib/brand/seasons.ts — and the board and the activation gate
-- both call it. It is deliberately not restated in SQL: a second copy of a rule
-- is a copy that drifts, and the drift would only surface the day someone
-- activated a season they should not have.
--
-- What SQL owns is the ESCAPE. A brewery sometimes has to move before the
-- design is finished, and a gate with no escape gets worked around in ways
-- nobody can see. So a season may go into force incomplete — with a reason,
-- stored here, and shown on the board. A recorded reason is visible; a disabled
-- check is not.
--
-- Design: docs/brand/season-kit-spec.md §7 · brief: docs/brand/chips/03-season-clone-and-gate.md
--
-- NOTHING EXISTING IS TOUCHED. "Season 1" is active with every field empty and
-- stays exactly that way: the gate applies to ACTIVATION, not to what is
-- already in force, and this file adds one nullable column and one constraint
-- over it. No status is changed, no content is backfilled, and no reason is
-- invented on any row's behalf. Whether "Season 1" is filled in or archived is
-- a human decision, not a migration's.
--
-- Re-runnable end to end: both statements are guarded.
-- ============================================================================

-- ─── brand_seasons.activation_override_reason ───────────────────────────────
--
-- Why the last activation was allowed to go ahead with the kit incomplete, or
-- NULL when it was not — which is both the "never overridden" case and the
-- "activated clean" case. `activateSeason()` clears the column on a complete
-- activation, so the value always describes the activation currently in effect
-- rather than a claim about some earlier one.
alter table public.brand_seasons
  add column if not exists activation_override_reason text;

-- NO REASON, NO OVERRIDE — asserted here as well as in TypeScript.
--
-- The gate itself cannot live in SQL (see the header), but this half can: an
-- empty or whitespace-only string is not a reason, and storing one would make
-- the board render an override with nothing to show for it. The application
-- normalises blank to NULL; this makes that a rule rather than a habit, for
-- the same reason the palette's shape CHECK exists next to its TypeScript
-- validator.
--
-- Guarded by pg_constraint rather than `drop … if exists` + `add`, so a replay
-- is a true no-op and never momentarily leaves the table unconstrained.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.brand_seasons'::regclass
      and conname  = 'brand_seasons_override_reason_not_blank'
  ) then
    alter table public.brand_seasons
      add constraint brand_seasons_override_reason_not_blank check (
        activation_override_reason is null
        or length(btrim(activation_override_reason)) > 0
      );
  end if;
end $$;

comment on column public.brand_seasons.activation_override_reason is
  'Why this season was put into force with an incomplete kit, or NULL if it was not. Completeness is kitGaps() in lib/brand/seasons.ts — deliberately not restated in SQL, so there is one rule and not two. Cleared by a clean activation, so the value always describes the activation in effect. Never set by a migration: "Season 1" predates this gate and is grandfathered, not overridden.';
