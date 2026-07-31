-- Brand canon: give every naming example a story line and a menu description.
--
-- The Voice tab now renders four lines per passing example — name, story line,
-- menu description, why it passes — and `canon.schema.ts` requires all four
-- keys. Before this, an example carried `name` and `why` only, and the missing
-- slots showed: the published 1.7 document's first example holds a story line
-- in its `why` field ("In Pingxi, they say a wish doesn't count until you lose
-- sight of it…") while its three siblings hold verdicts. One field was doing
-- two jobs because there was nowhere else to put the writing.
--
-- So this migration does two things:
--   1. adds `story` and `menuDescription` to every example in every row
--      (published, draft and archived — archived rows are restorable history
--      and must satisfy the same schema), and
--   2. moves that Pingxi story out of `why` into `story`, leaving `why` to say
--      what it is supposed to say: which criteria the name clears.
--
-- Content is keyed by example NAME, so the archived rows that still say "Peach
-- Blossom Spring" get filled alongside the current "Drifting Through the
-- Clouds". A name not in the table gets empty strings — the keys exist, the
-- schema is satisfied, and the Voice tab shows blank fields to fill in.
--
-- Idempotent: an example that already has a non-empty story or menu line keeps
-- it, and the `why` swap only fires while `why` still holds the story verbatim.
--
-- Human-gated (do not auto-apply). This writes brand copy to the live
-- published canon — read the content below before applying it.

with content(name, story, menu, why) as (
  values
    (
      'Drifting Through the Clouds — Jasmine Peach Lager',
      'In Pingxi, they say a wish doesn''t count until you lose sight of it. By midnight, the whole valley had stopped counting.',
      'Jasmine, ripe peach, and a clean dry finish.',
      'A specific place-moment — Pingxi on lantern night; jasmine and peach are in the glass'
    ),
    (
      'Peach Blossom Spring — Jasmine Peach Lager',
      'A fisherman follows fallen peach blossoms upstream and finds a village that forgot the world outside. Sixteen centuries later, people are still looking for the place.',
      'Soft, floral, gently sweet — an easy first step.',
      null
    ),
    (
      'First Light at Alishan — High-Mountain Oolong Golden Ale',
      'The train climbs all night so you can stand above the clouds at five in the morning and watch the sun come up over the tea terraces.',
      'Toasted oolong and orchid, dry and clean at the finish.',
      null
    ),
    (
      'Convenience Store Rain — Milk Tea Stout',
      'Waiting out a downpour under a shop awning with a hot milk tea, in no particular hurry for it to stop.',
      'Black tea, malt and cream — dark, but not heavy.',
      null
    ),
    (
      'Grandmother’s Kumquat Jar — Kumquat Sour',
      'The jar kept on the back step — kumquats and rock sugar — opened by the spoonful whenever anyone had a cough.',
      'Bright, tart, honeyed citrus; a small sharp lift.',
      null
    )
)
update public.brand_canon_versions v
set document = jsonb_set(
  v.document,
  '{naming,passingExamples}',
  coalesce(
    (
      select jsonb_agg(
        ex || jsonb_build_object(
          'story', coalesce(nullif(ex ->> 'story', ''), c.story, ''),
          'menuDescription', coalesce(nullif(ex ->> 'menuDescription', ''), c.menu, ''),
          -- Only rewrite `why` where it still holds the story verbatim.
          'why', case
                   when c.why is not null and ex ->> 'why' = c.story then c.why
                   else ex ->> 'why'
                 end
        )
        order by ord
      )
      from jsonb_array_elements(v.document #> '{naming,passingExamples}')
        with ordinality as t(ex, ord)
      left join content c on c.name = ex ->> 'name'
    ),
    '[]'::jsonb
  )
)
where jsonb_typeof(v.document #> '{naming,passingExamples}') = 'array'
  and jsonb_array_length(v.document #> '{naming,passingExamples}') > 0;
