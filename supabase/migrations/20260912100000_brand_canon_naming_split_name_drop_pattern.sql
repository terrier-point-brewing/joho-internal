-- Brand canon: split a naming example's name into its two halves, and drop the
-- pattern that existed only to describe them.
--
-- `naming.pattern` said "Story Title — Beer Style" and `passingExamples[].name`
-- held "Drifting Through the Clouds — Jasmine Peach Lager" as one string. So the
-- rule sat in a sentence above the cards while the thing it governed was typed
-- freehand into a single box, with nothing keeping the two halves apart beyond
-- an editor remembering to type an em dash.
--
-- After this migration an example carries `storyTitle` and `beerStyle`, the
-- canon editor gives each its own input, and the guide composes the card title
-- from them. The pattern line is then a restatement of the two field labels, so
-- it goes — from the document here, and from the Voice tab and the agent brief
-- in the same change.
--
-- Splitting on the FIRST " — " (space, em dash, space). Every stored name uses
-- exactly one; a name without it keeps the whole string as `storyTitle` and gets
-- an empty `beerStyle` rather than being guessed at.
--
-- Applies to published, draft AND archived rows — archived documents are
-- restorable history and must satisfy the same schema.
--
-- Idempotent: an example that already has `storyTitle` is left alone, and the
-- pattern removal is a no-op once the key is gone.
--
-- Human-gated (do not auto-apply). This rewrites brand copy in the live
-- published canon.

-- 1. name → storyTitle + beerStyle
update public.brand_canon_versions v
set document = jsonb_set(
  v.document,
  '{naming,passingExamples}',
  coalesce(
    (
      select jsonb_agg(
        (ex - 'name') || jsonb_build_object(
          'storyTitle',
          coalesce(
            nullif(ex ->> 'storyTitle', ''),
            case
              when position(' — ' in coalesce(ex ->> 'name', '')) > 0
                then left(ex ->> 'name', position(' — ' in ex ->> 'name') - 1)
              else coalesce(ex ->> 'name', '')
            end
          ),
          'beerStyle',
          coalesce(
            nullif(ex ->> 'beerStyle', ''),
            case
              when position(' — ' in coalesce(ex ->> 'name', '')) > 0
                then substr(ex ->> 'name', position(' — ' in ex ->> 'name') + 3)
              else ''
            end
          )
        )
        order by ord
      )
      from jsonb_array_elements(v.document #> '{naming,passingExamples}')
        with ordinality as t(ex, ord)
    ),
    '[]'::jsonb
  )
)
where jsonb_typeof(v.document #> '{naming,passingExamples}') = 'array'
  and jsonb_array_length(v.document #> '{naming,passingExamples}') > 0
  and exists (
    select 1
    from jsonb_array_elements(v.document #> '{naming,passingExamples}') as ex
    where ex ? 'name' or not (ex ? 'storyTitle')
  );

-- 2. drop the pattern
update public.brand_canon_versions v
set document = v.document #- '{naming,pattern}'
where v.document #> '{naming,pattern}' is not null;
