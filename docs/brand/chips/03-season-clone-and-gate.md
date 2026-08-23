# Season kit — chip 3: clone, and the completeness gate

**Read `docs/brand/season-kit-spec.md` in full first**, especially §7.

Chips 1 and 2 are merged: the schema, and the board that renders a kit and says
what is missing from it.

---

## 1. Intent

A season is a ritual. Will runs it now, a few times a year; someone may be hired
to run it quarterly later. That is the same job either way, and it needs two
things the board alone does not give it.

**Cloning**, because half of a season is continuity and re-picking it by hand
every quarter is how a brand drifts.

**A completeness gate**, because nothing currently stops an empty season being
the active one. That is not hypothetical: "Season 1" has been active with every
field empty for as long as it has existed, and nothing anywhere said so. A
person new to the job would have no way to know what finished looks like — and
evidently neither did the system.

## 2. What this chip owns

### 2.1 Clone from the last season

From the active or most recent season, create a **draft**:

- **Carried** — palette roles, voice note, cultural lean, examples.
- **Cleared** — `background_hex`, chop glyph, season logo, motifs, `starts_at`, `ends_at`.

That split is the point: what carries is continuity, what clears is what
actually rotates. A clone is **never active on creation**, no matter what it was
cloned from.

### 2.2 The completeness gate

A kit is **complete** when it has all of: a ground (`background_hex`), a chop
glyph, at least one motif, at least one example, and a voice note.

- Activating an incomplete season is **refused**, and the refusal **names every missing piece** in one sentence a person can act on — not a code, not a list of field names.
- The check lives in `lib/brand/seasons.ts` as a pure function over a season and its assets, unit-tested for every combination of missing piece. The UI and any route both call it; neither re-implements it.
- **The override is deliberate and recorded.** A season may be activated incomplete with a reason, stored on the season (`activation_override_reason text`). No reason, no override. The board shows that a season was activated incomplete and why.

The override exists because a brewery sometimes has to move before the design is
finished, and a gate with no escape gets worked around in ways nobody can see. A
recorded reason is visible; a disabled check is not.

### 2.3 What this does not do to the existing season

**"Season 1" is grandfathered, not broken.** It is already active and already
incomplete; the gate applies to *activation*, so it stays active until someone
changes it. Do not write a migration that deactivates it or invents an override
reason for it. Per the spec's definition of done, Will fills it in or archives
it — that is a human act, and this chip's job is only to make sure it cannot
happen again silently.

## 3. Gate

- [ ] `npm run verify`, `check:permissions --strict`, `check:migrations --strict`, `npm run build` green.
- [ ] The completeness function is unit-tested for **each** missing piece individually and for a complete kit.
- [ ] Cloning: carried fields carry, cleared fields clear, the clone is a draft, and cloning twice does not collide.
- [ ] **In the browser**: activating an incomplete season is refused and the message names what is missing; supplying a reason activates it and the board shows the reason; a complete season activates with no reason asked.
- [ ] Activating a season deactivates the previous one, and the single-active partial unique index is never violated — prove it, including two activations in quick succession.
- [ ] **"Season 1" is still active and untouched** after all of this. Show it.
- [ ] Screenshots of the refusal, the override, and a clean activation. Leave Chrome tabs open.
- [ ] Any test data removed; confirm with counts.

## 4. Do not build

- Any change to the board's rendering beyond what the gate and clone require — chip 2 owns it.
- A migration that touches existing season rows' status or content.
- Social-size previews, `brand_templates`, `brand_outputs`.
- Any canon change.
- Any Canva integration.
- Any Marketing change, or any port in `lib/marketing/ports/`.
- A "seasons" permission scope — `brand.templates` is the grant, and a hire gets that and nothing else.

## 5. Report back

What you built, gate results, screenshots, confirmation that "Season 1" is
untouched, any deviation and why, and anything in the brief that turned out to
be wrong.
