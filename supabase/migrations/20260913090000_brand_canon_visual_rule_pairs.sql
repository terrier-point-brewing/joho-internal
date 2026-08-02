-- Brand canon: Visual Identity rules become do/don't PAIRS.
--
-- The rules were stored as one flat list, each entry carrying a polarity, and
-- rendered as two independent columns. They were never independent: "flat,
-- screen-print vector rendering" and "no photorealism" are one rule stated from
-- both ends, and in two columns they sat at different heights and drifted
-- further apart with every rule above them. The new shape is
--   illustrationLaw.pairs[] = { id, title, do{caption,brief,assetId},
--                               dont{...}, nuance }
-- so each rule holds the failure it prevents, level with itself.
--
-- The content below is authored, not transformed. The eight stored rules
-- re-fold into seven pairs (some existed only as a do, some only as a don't),
-- and the founder rewrote every caption and nuance line in the process — no
-- mechanical rewrite could produce it. `brief` is art direction for
-- illustrations that are not commissioned yet; the guide shows it in the empty
-- image slot.
--
-- `illustrationLaw.rules` is dropped from the rows this touches. The
-- application tolerates BOTH shapes (lib/brand/rulePairs.ts folds a legacy list
-- into pairs on read) and the Visual Identity editor writes pairs the first
-- time an admin saves it, so applying this late degrades to "the old rules
-- render as half-filled pairs", never to a broken page.
--
-- Style homage moves OUT of the rule set into illustrationLaw.homage. It is a
-- permission with no failure opposite it — as a card it would be the one entry
-- with an empty half — so it renders as a line beneath the introduction.
--
-- Scope: the draft and the published row only. Archived versions are the
-- historical record of what the guide said at the time and are left exactly as
-- they were; diffCanon reports the shape change against the published row,
-- which is the accurate changelog entry.
--
-- Idempotent: skips any row that already holds `pairs`.
--
-- Human-gated (do not auto-apply).

update public.brand_canon_versions
set document = jsonb_set(
      document,
      '{illustrationLaw}',
      jsonb_build_object(
        'homage',
        'Style homage is permitted, including Ghibli-adjacent, when it serves the story and stays within the rules above.',
        'pairs',
        jsonb_build_array(
          jsonb_build_object(
            'id', gen_random_uuid()::text,
            'title', 'Illustrate the moment the name points to',
            'do', jsonb_build_object(
              'caption', 'The brick stove, the kettle, low light.',
              'brief', 'Ah-Mah''s Stove label'
            ),
            'dont', jsonb_build_object(
              'caption', 'The whole night-market crowd, narrated.',
              'brief', 'Story line painted literally'
            ),
            'nuance', 'The name is one picturable image of a feeling. The illustration is that image, rendered. If the scene could belong to a different beer, it isn''t the one yet.'
          ),
          jsonb_build_object(
            'id', gen_random_uuid()::text,
            'title', 'Flat, screen-print vector rendering',
            'do', jsonb_build_object(
              'caption', 'Hard-edged flats, gradient only in the sky.',
              'brief', 'Dusk sky over flat rooftops'
            ),
            'dont', jsonb_build_object(
              'caption', 'Photorealism.',
              'brief', 'Photographic street scene'
            ),
            'nuance', 'Flat color survives a can, a shirt, and a phone screen. Realism makes the place a record instead of a memory. Sky is the one exception, because atmosphere is what flat color can''t do.'
          ),
          jsonb_build_object(
            'id', gen_random_uuid()::text,
            'title', 'One real place, not five famous ones',
            'do', jsonb_build_object(
              'caption', 'The alley behind the stall, at one hour.',
              'brief', 'Single lit corner'
            ),
            'dont', jsonb_build_object(
              'caption', 'Landmark medley.',
              'brief', 'Pagoda, torii, skyline stacked'
            ),
            'nuance', 'A greatest-hits skyline is a category, not a place. Same failure as naming a beer after a mood.'
          ),
          jsonb_build_object(
            'id', gen_random_uuid()::text,
            'title', 'Seven colors, sky gradient excluded',
            'do', jsonb_build_object(
              'caption', 'Seven flat chips, one composed scene.',
              'brief', 'Palette beside its label'
            ),
            'dont', jsonb_build_object(
              'caption', 'Reaching for the twelfth color.',
              'brief', 'Over-saturated accumulated scene'
            ),
            'nuance', 'The cap forces a scene to be composed rather than accumulated, and it''s why our labels read from across a room. When a piece needs an eighth color, it usually needs a simpler scene.'
          ),
          jsonb_build_object(
            'id', gen_random_uuid()::text,
            'title', 'Name the light and the hour',
            'do', jsonb_build_object(
              'caption', 'Dawn, dusk, or lamplight, specified in the brief.',
              'brief', 'One street at three hours'
            ),
            'dont', jsonb_build_object(
              'caption', 'Flat noon.',
              'brief', 'Same street, no hour to it'
            ),
            'nuance', 'Light is how a scene gets a feeling, and the feeling is the whole point of the name. Noon is a lighting condition, not a moment someone would remember.'
          ),
          jsonb_build_object(
            'id', gen_random_uuid()::text,
            'title', 'Figures small and anonymous',
            'do', jsonb_build_object(
              'caption', 'Distant silhouettes, faces unreadable.',
              'brief', 'Two figures under lantern light'
            ),
            'dont', jsonb_build_object(
              'caption', 'A face front and center.',
              'brief', 'Someone else''s evening'
            ),
            'nuance', 'Nobody should recognize a stranger on the label. They should recognize a position they could occupy. Distance keeps the scene theirs.'
          ),
          jsonb_build_object(
            'id', gen_random_uuid()::text,
            'title', 'Clean vector logic',
            'do', jsonb_build_object(
              'caption', 'Every shape explainable.',
              'brief', 'Clean railing, correct hands'
            ),
            'dont', jsonb_build_object(
              'caption', 'AI-artifact incoherence.',
              'brief', 'Melting railing, extra fingers'
            ),
            'nuance', 'Broken geometry reads as carelessness, and carelessness is the one thing the brand can''t afford when its whole claim is that the care goes into everything around the beer too.'
          )
        )
      )
    )
where status in ('draft', 'published')
  and document #> '{illustrationLaw,pairs}' is null;
