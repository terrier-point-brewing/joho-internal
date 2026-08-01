-- Brand canon: turn the naming narrative from one paragraph into the template
-- it was describing.
--
-- `naming.narrative` was a single string, and on the Voice tab it rendered as
-- five paragraphs of prose sitting directly above four example cards labelled
-- NAME / STORY LINE / MENU DESCRIPTION / WHY IT PASSES. The prose was explaining
-- those exact four labels — the rule for a line lived several hundred words away
-- from every example of that line, and the wall of text was the first thing a
-- reader hit after the five criteria.
--
-- So the narrative becomes an object with the SAME keys a passing example has,
-- plus an `intro` above the card and a `footer` (the read-it-aloud test) at its
-- foot. `canon.schema.ts` now requires that shape, and the Voice tab renders it
-- through the same card component as the examples, with an accent border and a
-- "Naming — narrative" tag as the only differences.
--
-- Content is the published paragraph's own writing, cut to the instruction in
-- each slot: the "each line has one job" framing becomes `intro`, the Ah-Mah's
-- Stove / "First Cold Night" pair folds into `name` as a parenthetical, and the
-- closing test becomes `footer`. Nothing else is added.
--
-- Applies to published, draft AND archived rows — archived documents are
-- restorable history and must satisfy the same schema.
--
-- Idempotent: only rows whose narrative is still a JSON string are rewritten,
-- so a row already carrying the object (or edited afterwards) is left alone.
--
-- Human-gated (do not auto-apply). This writes brand copy to the live published
-- canon — read the content below before applying it.

update public.brand_canon_versions v
set document = jsonb_set(
  v.document,
  '{naming,narrative}',
  jsonb_build_object(
    'intro',
    'Each line of a release card has one job. When every line does only its own, the card feels effortless; when one tries to do another''s, it reads like marketing.',
    'name',
    'A single picturable image of the feeling the beer is for — the relief, the bloom, the warmth. Never the circumstances around the feeling, and never its category; the test is one glance, as a caption to a photograph in our magazine. (Ah-Mah''s Stove, Still Warm passes. “First Cold Night” fails, because it points at the cold instead of the warmth.)',
    'story',
    'One or two sentences in found-text register, as if torn from a travel magazine or a quiet novel. A real place, an observed moment, one soft turn at the end. This is the only line allowed to name geography — the name stays figurative because the story line does the anchoring.',
    'menuDescription',
    'What you taste, in the order you taste it, closing on a short piece of friend''s advice. Start here. Follow your nose. For the coldest walk home — five words or fewer, practical and warm.',
    'why',
    'One terse line for internal review, touching only criteria one and two: the story, then the flavor link. The other three are pass-or-fail hygiene and don''t need restating.',
    'footer',
    'Read the finished card aloud. If it sounds like something you''d say to a friend across the bar, it''s ours.'
  )
)
where jsonb_typeof(v.document #> '{naming,narrative}') = 'string';
