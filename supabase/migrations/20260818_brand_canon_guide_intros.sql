-- Brand Guide introductions become a first-class part of the canon document.
--
-- Each Brand Guide subtab now opens with an editable introduction block stored
-- at document.guideIntros.<subtab>. Three subtabs previously kept that prose in
-- their own differently-shaped fields, and four kept it nowhere at all (it was
-- hardcoded in the view components). This moves all seven into one place:
--
--   missionNarrative                     -> guideIntros.ethos
--   voice.summary + voice.personality    -> guideIntros.voice  (blank-line join)
--   illustrationLaw.narrative            -> guideIntros.visual
--   (was hardcoded in the components)    -> guideIntros.color / type / marks / agent
--
-- Also drops `mission`: the one-line mission is no longer shown anywhere and is
-- not being replaced.
--
-- Only draft + published rows are rewritten. Archived rows are historical
-- snapshots and are deliberately left byte-for-byte as published.
--
-- Idempotent: re-running finds the source keys already removed, builds nulls,
-- and jsonb_strip_nulls drops them — while the `|| existing` merge order keeps
-- whatever guideIntros are already stored. Safe to run twice.
--
-- Not required for correctness: lib/brand/guideIntros.ts falls back to the seed
-- per subtab, so the guide renders the same prose before and after. This makes
-- the database the source of truth rather than the code fallback.
--
-- Human-gated (do not auto-apply).

update public.brand_canon_versions
set document =
  (document - 'mission' - 'missionNarrative')
  || jsonb_build_object(
       'voice', (document -> 'voice') - 'summary' - 'personality',
       'illustrationLaw', (document -> 'illustrationLaw') - 'narrative',
       'guideIntros',
         jsonb_strip_nulls(
           jsonb_build_object(
             'ethos', document ->> 'missionNarrative',
             'voice', nullif(
               concat_ws(
                 E'\n\n',
                 document -> 'voice' ->> 'summary',
                 document -> 'voice' ->> 'personality'
               ),
               ''
             ),
             'visual', document -> 'illustrationLaw' ->> 'narrative',
             'color', 'Roles, not names — every surface binds to one of these thirteen. Edit mode maps roles to the palette (admins only).',
             'type', 'One family per role. Edit mode assigns the loaded families (admins only).',
             'marks', 'The fixed identity artifacts and their specifications — the wordmark, logo, and chop.',
             'agent', 'The machine-facing brand rules — reference for agents building on the brand.'
           )
         )
         -- Anything already stored under guideIntros wins over the values
         -- rebuilt above, so an admin edit made before this migration ran is
         -- never overwritten.
         || coalesce(document -> 'guideIntros', '{}'::jsonb)
     )
where status in ('draft', 'published');
