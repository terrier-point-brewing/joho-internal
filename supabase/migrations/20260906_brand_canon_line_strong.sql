-- Give `line-strong` a border that actually reads as strong.
--
-- It was bound to Camphor Tan, which sits at 1.99:1 on Paper — only 0.8 above
-- `line` (Paper 3, 1.20:1). Two tokens named "line" and "line-strong" that a
-- reader cannot tell apart are one token with extra steps, and there was no
-- emphasized divider available at all.
--
-- Camphor Deep is Camphor Tan's own hue and saturation (42°, 23%) darkened to
-- the minimum lightness that clears 3:1 against all three light grounds:
--   Paper 3.98  ·  Paper 2 3.71  ·  Paper 3 3.10
--
-- Camphor Tan itself is untouched and keeps driving `secondary`.
--
-- 3:1 is WCAG 1.4.11's threshold for user-interface component boundaries. The
-- controls using this token all carry visible text labels, so the obligation
-- was arguably already met — the stronger reason is that an emphasis token
-- should be able to emphasize.
--
-- Dark mode is unaffected: `line-strong` binds to Indigo 3 there.
--
-- Safe to apply at any time. Idempotent — skips if the key already exists.
--
-- Human-gated (do not auto-apply).

-- 1. Add the color.
update public.brand_canon_versions
set document = jsonb_set(
  document,
  '{palette}',
  (document -> 'palette') || '{
     "key":"camphor-deep","name":"Camphor Deep","hex":"#847552","tier":"neutral",
     "role":"Emphasized dividers and control borders in light mode"
   }'::jsonb
)
where document ? 'palette'
  and not exists (
    select 1
    from jsonb_array_elements(document -> 'palette') as existing
    where existing ->> 'key' = 'camphor-deep'
  );

-- 2. Point light-mode line-strong at it.
update public.brand_canon_versions
set document = jsonb_set(document, '{roleMap,light,line-strong}', '"camphor-deep"'::jsonb)
where document #> '{roleMap,light}' is not null;
