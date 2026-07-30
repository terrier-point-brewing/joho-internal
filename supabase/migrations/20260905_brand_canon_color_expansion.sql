-- Brand canon: expand the palette to cover dark mode, tier every color, fix one
-- contrast failure, and bind every dark role to a palette color.
--
-- Dark mode INVERTS Indigo and Paper rather than adding a parallel neutral ramp:
-- primary becomes Paper on an Indigo surface, so seven of the thirteen dark
-- roles bind to colors the brand already owns and only five new entries are
-- needed. Indigo, Paper, Seal Red and Camphor Tan are untouched.
--
-- Indigo is the dark SURFACE, not the canvas. Dark elevation has to run
-- monotonically (canvas darkest → raised lightest) and Indigo sits at relative
-- luminance 3.7 — as the floor, every raised surface above it becomes a vivid
-- saturated blue that competes with content. Midnight sits beneath it instead.
--
-- ⚠️ CONTRAST FIX INCLUDED: content-muted #6b6f7d fails WCAG AA on all three
-- light grounds today (4.41 / 4.11 / 3.43). It moves to #575a66 (6.04 / 5.63 /
-- 4.70), same hue and saturation, so it still reads as the same color.
--
-- After this migration every text and label pairing clears its applicable
-- threshold in both modes. Accent is deliberately held to AA-large (3:1) on the
-- two lighter dark grounds: the canon already forbids Seal Red as body text
-- below 18px and caps it at 5% of a composition, so large-text contrast is the
-- correct target for a color that is never small body text.
--
-- Safe to apply at any time. lib/brand/tokens.ts falls back to the runtime
-- derivation for any dark role this does not set, so the code renders
-- identically before and after — this migration replaces computed colors with
-- named ones, it does not enable anything.
--
-- Idempotent: colors whose key already exists are skipped.
--
-- Human-gated (do not auto-apply).

-- Step 1 — tier every existing color, drop the misleading "(derived)" suffix
-- (these are hand-authored UI neutrals, not computed from anything), and fix
-- content-muted's hex.
update public.brand_canon_versions
set document = jsonb_set(
  document,
  '{palette}',
  (
    select coalesce(jsonb_agg(
      case c ->> 'key'
        when 'indigo'   then c || '{"tier":"core"}'::jsonb
        when 'paper'    then c || '{"tier":"core"}'::jsonb
        when 'seal-red' then c || '{"tier":"core"}'::jsonb
        when 'camphor'  then c || '{"tier":"core"}'::jsonb
        when 'paper-2'  then c || '{"tier":"neutral","name":"Paper 2"}'::jsonb
        when 'paper-3'  then c || '{"tier":"neutral","name":"Paper 3"}'::jsonb
        when 'content'  then c || '{"tier":"neutral","name":"Content Ink"}'::jsonb
        when 'content-muted'
          then c || '{"tier":"neutral","name":"Content Ink Muted","hex":"#575a66"}'::jsonb
        else c || '{"tier":"neutral"}'::jsonb
      end
      order by idx
    ), '[]'::jsonb)
    from jsonb_array_elements(document -> 'palette') with ordinality as t(c, idx)
  )
)
where document ? 'palette';

-- Step 2 — append the five new dark-mode colors, one statement each so a
-- partial apply is obvious and re-running is a no-op.
do $$
declare
  new_colors jsonb := '[
    {"key":"midnight","name":"Midnight","hex":"#131b2f","tier":"neutral",
     "role":"Dark-mode canvas, and the label color on dark accents"},
    {"key":"indigo-2","name":"Indigo 2","hex":"#364672","tier":"neutral",
     "role":"Dark-mode raised surfaces and hairlines"},
    {"key":"indigo-3","name":"Indigo 3","hex":"#4b5c8b","tier":"neutral",
     "role":"Dark-mode emphasized dividers"},
    {"key":"chalk","name":"Chalk","hex":"#afb7ca","tier":"neutral",
     "role":"Dark-mode muted body text"},
    {"key":"vermilion","name":"Vermilion","hex":"#f37149","tier":"core",
     "role":"Dark-mode accent — Seal Red is unreadable on Indigo grounds"}
  ]'::jsonb;
  color jsonb;
begin
  for color in select * from jsonb_array_elements(new_colors)
  loop
    update public.brand_canon_versions
    set document = jsonb_set(document, '{palette}', (document -> 'palette') || color)
    where document ? 'palette'
      and not exists (
        select 1
        from jsonb_array_elements(document -> 'palette') as existing
        where existing ->> 'key' = color ->> 'key'
      );
  end loop;
end $$;

-- Step 3 — bind every dark role to a palette key. Zero detached hexes: fully
-- symmetric with light. Runs last so the keys it references already exist.
update public.brand_canon_versions
set document = jsonb_set(
  document,
  '{roleMap,dark}',
  '{
     "canvas": "midnight",
     "surface": "indigo",
     "surface-raised": "indigo-2",
     "line": "indigo-2",
     "line-strong": "indigo-3",
     "primary": "paper",
     "on-primary": "indigo",
     "high-contrast": "paper",
     "content": "paper-2",
     "content-muted": "chalk",
     "accent": "vermilion",
     "on-accent": "midnight",
     "secondary": "camphor"
   }'::jsonb
)
where document #> '{roleMap}' is not null;
