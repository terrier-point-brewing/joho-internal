-- Brand canon: upgrade bare-string rule lists to illustrated GuideRule objects.
--
-- `illustrationLaw.rules` (Visual Identity) and `colorForbidden` (Color) held
-- arrays of plain strings. Phase 2 widened both to accept
--   { id, polarity, title, detail?, assetId?, caption? }
-- so each rule can carry an image and say whether it's a do or a don't.
--
-- The application already tolerates BOTH shapes (lib/brand/guideRules.ts
-- normalizes on read), and the rule editor writes the rich shape back the first
-- time an admin touches a tab. So this migration is a convenience, not a gate —
-- it upgrades rows nobody edits. Applying it late, or not at all, degrades to
-- "rules render without images", never to a broken page.
--
-- Polarity defaults differ by field and are not guesses:
--   colorForbidden        → 'dont'  (every entry is a prohibition by definition)
--   illustrationLaw.rules → 'do'    (historically written as positive laws)
-- Re-polarise individual rules in the editor afterwards.
--
-- Idempotent: elements that are already objects are left alone.
--
-- Human-gated (do not auto-apply).

-- Rewrites one jsonb array, converting string elements to rule objects and
-- passing existing objects through untouched.
create or replace function public.brand_canon_rules_to_objects(
  rules jsonb,
  default_polarity text
) returns jsonb
language sql
immutable
as $$
  select coalesce(
    jsonb_agg(
      case
        when jsonb_typeof(elem) = 'string'
          then jsonb_build_object(
            'id', gen_random_uuid()::text,
            'polarity', default_polarity,
            'title', elem #>> '{}'
          )
        else elem
      end
      order by idx
    ),
    '[]'::jsonb
  )
  from jsonb_array_elements(coalesce(rules, '[]'::jsonb)) with ordinality as t(elem, idx);
$$;

update public.brand_canon_versions
set document = jsonb_set(
      jsonb_set(
        document,
        '{colorForbidden}',
        public.brand_canon_rules_to_objects(document -> 'colorForbidden', 'dont')
      ),
      '{illustrationLaw,rules}',
      public.brand_canon_rules_to_objects(document #> '{illustrationLaw,rules}', 'do')
    )
where document ? 'colorForbidden'
   or document #> '{illustrationLaw,rules}' is not null;

-- The helper exists only for this migration.
drop function if exists public.brand_canon_rules_to_objects(jsonb, text);
