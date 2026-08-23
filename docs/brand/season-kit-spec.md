# Season kits

A season is already a table. This makes it a **kit** — the set of things that
rotate together, complete enough that a person can look at it and tell whether
the season hangs together, and specific enough that Marketing can build a post
out of it later.

Brand-side only. Canva is deliberately out of scope. The Marketing port is named
at the end and not built.

---

## 1. Where this starts

`brand_seasons` exists, with a real model behind it: a season carries the two
things a `motif` slot resolves — a ground colour and a chop glyph — plus a
season logo, a `motif_set`, a cultural lean, and dates. One season is active at
a time, enforced by a partial unique index. `SeasonEditor.tsx` already splits
render inputs from brief fields, on purpose.

What is actually in the database, though:

- **one season, named "Season 1", with every field empty**
- **zero templates**
- **zero outputs**
- assets: 12 wordmarks, 12 examples, 2 chop glyphs, and nothing else

So the render pipeline was designed in full and has never been run. This is not
a modelling problem to solve, it is an empty room to furnish — and one genuine
gap to close.

## 2. The gap

The season model was built for **labels**. Its own comment says a season carries
only what a motif slot resolves, because "position, footprint, color and
rendering never change". For a can that is exactly right.

Social is not a can. A season that has to hold up across a feed needs things a
label never asks for: what the season's photography looks like, how the type
sits at social sizes, and how the season sounds. None of those are placement
rules, so none of them belong in the canon — and none of them exist today.

## 3. The organising rule

**A season selects and inflects. It never redefines.**

The canon owns the brand: its colours, its type, its voice, its placement rules.
A season chooses from that set and adds a seasonal layer on top. A season may
not introduce a brand colour, restyle the wordmark, or contradict the canon —
and if a season seems to need to, the canon is what should change.

Every decision below follows from that sentence.

## 4. What a kit holds

### 4.1 Already there, to be filled in rather than rebuilt

`background_hex` (the season ground), `chop_glyph_asset_id`, `season_logo_asset_id`,
`cultural_lean`, `starts_at`/`ends_at`, `status`.

### 4.2 `motif_set` gets a real editor

It is on the table already and deliberately unedited — `SeasonEditor.tsx` says
so, because nothing read it. Give it a picker: ordered, multi-select, drawn from
approved assets, with a per-item note. This is the season's visual vocabulary,
and it is the single largest thing missing today.

### 4.3 A palette of **roles**, not colours

Add `palette jsonb` to `brand_seasons`: a small map of role → canon token, plus
the one season ground that is genuinely new each time.

Roles, and no more: `ground`, `ink`, `accent`. Each points at a **canon token
key**, never a raw hex — except `ground`, which is the season's own and stays
`background_hex`. Storing a token key rather than a value means a canon change
propagates, and a season cannot quietly invent a fourth brand colour.

### 4.4 Art direction, as examples

The `example` asset kind already exists and already has twelve rows. Scope them
to a season and they become "this is what this season looks like" — the fastest
possible answer to a question that is otherwise argued about in a group chat.

### 4.5 A voice inflection, not a voice

`voice_note text` — one or two sentences on how this season sounds. Explicitly
an inflection of the canon's voice. If it reads like a replacement, it is wrong.

### 4.6 The join table

Add `brand_season_assets`: `season_id`, `asset_id`, `role`, `position`, PK on
`(season_id, asset_id, role)`. Roles: `motif`, `example`, `texture`.

A row, not a string in a jsonb blob — this repo has learned that lesson already
(`project_ingredient_units_are_rows_not_strings`), and a join table is what lets
an asset be ordered, re-roled, and queried without rewriting a document.

`motif_set` stays where it is for now and is migrated into this table by the
same chip that introduces it; nothing reads `motif_set` today, so there is no
compatibility to preserve.

## 5. How it should look

**A board, not a form.** The test is whether someone can glance at the season
and tell it hangs together. A stack of labelled inputs cannot answer that; a
board of swatches, the glyph, the motifs and the examples can.

Concretely, in Brand → Templates → Seasons:

- The kit renders as a **single panel per season**: ground swatch and role colours as actual colour, the chop glyph and season logo as images, motifs and examples as a thumbnail row, the cultural lean and voice note as prose.
- The **active season is visually distinct** and unmissable — one season is in force at a time and which one it is should never require reading a status chip.
- Editing happens **in place on that board**, not on a separate screen. The existing render-inputs / brief split in `SeasonEditor.tsx` is good and stays.
- An incomplete kit **says what is missing** in a sentence, and does not pretend to be finished. "Season 1" as it stands today should read as obviously unfurnished.

Everything uses existing primitives — `Card`, `Badge`, the tokens, the `.btn-*`
tiers. No new design language. `docs/UI_STANDARD.md` applies as written.

**Deliberately not now:** rendered previews at social sizes. That needs
`brand_templates(medium='social')`, of which there are zero, and it is a bigger
piece of work than the kit itself. The kit has to exist before anything can be
rendered from it.

## 6. How Marketing eventually consumes it

Not built here. Named so the shape is not invented twice.

`lib/marketing/ports/seasonKit.ts` — a **read-only** interface marketing
declares and the host implements from Brand, exactly as
`lib/marketing/ports/README.md` describes. It answers one question: *what is the
active season kit?* — the palette, the glyph, the motifs, the examples, the
voice note.

Two rules that come with it:

- **Marketing never writes through a port.** Pulling season creative onto the calendar is a deliberate human act that copies into `marketing_media`, never a silent reference that changes under a post that already went out.
- **The kit informs and offers; it never blocks.** Compose may prefill and suggest from the active season. It may not refuse a post for being off-season — a brewery posts about a burst pipe too.

## 7. Definition of done

- `brand_season_assets` exists, with RLS via `apply_grant_policies` on `brand.templates`, and `motif_set`'s contents migrated into it.
- `palette` and `voice_note` on `brand_seasons`; palette roles resolve to canon token keys and are validated against the canon rather than free text.
- The Seasons board renders a complete kit, marks the active season unmistakably, and names what is missing on an incomplete one.
- Motifs and examples can be added, ordered, re-roled and removed.
- **"Season 1" is either filled in or archived.** An empty active season is the current state and it should not survive this work.
- No canon change, no new brand colour, no label-path change. If the kit appears to need one, stop and report.
- `npm run verify`, `check:permissions --strict`, `check:migrations --strict`, `build` all green; browser verification with screenshots, since this repo has no UI test setup.

## 8. Open question for Will

**Who fills a season in, and how often?** If it is you, a handful of times a
year, the board above is right. If it is meant to be a repeatable operational
ritual — a new season every quarter, maybe by someone else — then it wants a
"start a season from the last one" path, and that changes the design. I have
assumed the former.
