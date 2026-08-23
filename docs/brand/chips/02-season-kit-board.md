# Season kit — chip 2: the board

**Read `docs/brand/season-kit-spec.md` in full first**, then `docs/UI_STANDARD.md`
§4 and §5 properly. This chip is judged on whether a person can look at a season
and tell it hangs together, so the visual standard is the requirement, not a
formality.

Chip 1 (schema) is merged: `brand_season_assets`, `palette`, `voice_note`.

---

## 1. Intent

A season is the rotation a brand runs on. Today the only way to see one is to
read a form, which cannot answer the question a season actually raises: *does
this hang together?*

**Build a board, not a form.** Swatches as colour, the glyph as an image, motifs
and examples as a row of thumbnails, the lean and the voice note as prose. The
test is a glance.

**A season selects and inflects; it never redefines.** Palette roles pick canon
token keys — the UI offers what the canon declares and nothing else. If a colour
someone wants is not in the canon, the answer is to change the canon, not to
type a hex here.

## 2. What this chip owns

`app/brand/templates/` (the Seasons view), plus whatever `lib/brand/seasons.ts`
needs to read and write the new fields, with tests.

### 2.1 The board

One panel per season, in Brand → Templates → Seasons:

- **Ground and role colours rendered as actual colour**, each labelled with the canon token it resolves to. A role pointing at a token the canon no longer declares must say so rather than rendering nothing.
- **Chop glyph and season logo as images**, not filenames.
- **Motifs and examples as a thumbnail row**, ordered, with each item's role visible.
- **Cultural lean and voice note as prose**, at readable width.
- **The active season is unmistakable.** One season is in force at a time and which one should never require reading a status chip.
- **An incomplete kit says what is missing, in a sentence.** "Season 1" as it stands today should read as obviously unfurnished — that is the acceptance case, not a hypothetical.

### 2.2 Editing, in place

Editing happens on the board, not on a separate screen. The existing
render-inputs / brief split in `SeasonEditor.tsx` is deliberate and stays.

- **Palette roles**: a picker over canon token keys. Never a free-text hex field. `ground` stays `background_hex` and keeps its colour input — it is the season's own.
- **Motifs and examples**: add from approved assets, reorder, change role, remove. Writes `brand_season_assets`, not `motif_set`.
- **Voice note**: a short textarea, with a hint that it inflects the canon's voice rather than replacing it.

### 2.3 House rules that will bite

- `StickyHeader` holds title and subtabs and **nothing else** — no buttons, no selects, no status text.
- `.btn-*` tiers own their geometry; overriding padding, height or width is an **eslint error**.
- **There is no `warning` colour.** Those tokens do not exist and the classes fail silently; the amber accent box is the house caution pattern.
- No raw colours anywhere **except** where a season's own colour is the content — a swatch renders `background_hex` because that hex *is* the data. Everything structural uses tokens.
- Primitives from `app/components/**`: `Card`, `Badge`, the tokens. No new ones.
- Note `TemplatesView.tsx` currently switches Templates/Seasons with `TabBar`. Brand's subtabs live in the sidebar, so this is the page's only tab row and is fine as-is. **Do not add a second one.**

## 3. Gate

There is no UI test setup in this repo — vitest runs in `node` with no jsdom —
so the browser is the gate and cannot be simulated.

- [ ] `npm run verify`, `check:permissions --strict`, `npm run build` green.
- [ ] Logic in `lib/brand/seasons.ts` is unit-tested: reading a kit, writing assets, resolving palette roles, and the "token no longer in the canon" case.
- [ ] **In the browser, signed in**: the board renders; a motif can be added, reordered, re-roled and removed and it persists; a palette role can be set from canon tokens and cannot be set to a free hex; the voice note saves.
- [ ] **Screenshot "Season 1" as it currently is** — an empty active season — showing it reads as unfurnished and names what is missing. This is the single most important screenshot.
- [ ] Screenshot a filled-in season for contrast. Use throwaway data and remove it afterwards, or fill in a draft season rather than the active one.
- [ ] Side-by-side against an existing Brand or Production screen, and say what you compared.
- [ ] Leave the Chrome tabs open.

## 4. Do not build

- The clone path or the completeness gate — chip 3. The board **displays** what is missing; it does not yet **prevent** activation.
- Any migration or schema change. If the board seems to need a column, **stop and report**.
- Social-size previews, or anything touching `brand_templates` / `brand_outputs`.
- Any canon change, or any path that introduces a brand colour.
- Any Canva integration.
- Any port in `lib/marketing/ports/`, or any Marketing change at all.
- Writes to `motif_set` — it is legacy from this chip onward.

## 5. Report back

What you built, gate results, **every screenshot**, what you compared against,
any deviation and why, and anything in the brief that turned out to be wrong.
