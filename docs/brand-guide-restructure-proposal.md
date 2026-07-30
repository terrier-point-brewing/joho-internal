# Brand Guide restructure — proposal

Status: **draft for review**. Nothing implemented yet.

### Decisions locked (2026-07-30)

| # | Decision |
|---|---|
| Q1 | Voice vocabulary **stays on the Voice tab**, restructured as a Vocabulary panel (§3.2). Still compiles into the Agent Rules markdown. |
| Q2 | **Whole-document publish**, with the publish bar listing changed sections and previewing the generated changelog (§4.4). |
| Q3 | **`brand-assets` becomes a private bucket entirely** — nothing is served to unauthenticated users today. A public bucket gets spun up later, when there's a public site, for the subset that should be exposed. See §5.1. |
| Q4 | **Hard-migrate** the stored canon rows per phase and drop legacy fields (§5.2). |
| Q5 | **The guide renders itself from the canon** — no hand-coded color or type in guide components (§1.2). |
| Q6 | **Dark mode binds to palette keys**, symmetric with light. Auto-derive becomes a one-time editor action that snaps to the palette and offers new entries where nothing fits (§3.4-B). |
| Q7 | Voice vocabulary sits **between calibration and in-practice** (§3.2). |
| Q8 | Mark cards stay **flat** — no click-to-reveal. Forbidden-color image slots ship **empty**, artwork added later. |

---

## 0. What's actually wrong today (root causes, not symptoms)

Before the design, the three structural problems that explain most of the pain:

### 0.1 Every save validates the *entire* canon

`saveDraft()` ([lib/brand/canonWorkflow.ts:113](lib/brand/canonWorkflow.ts:113)) runs `canonSchema.parse(document)` on the whole
document, no matter which subtab you edited. The schema has several exhaustive/strict
constraints:

| Constraint | Where |
|---|---|
| `roleMap.light` must contain **all 13** role keys | [canon.schema.ts:80](lib/brand/canon.schema.ts:80) |
| `visibility` must contain **all 12** section keys (incl. the dead `"mission"`) | [canon.schema.ts:203](lib/brand/canon.schema.ts:203) |
| `naming.criteria` must be **exactly 5** items | [canon.schema.ts:153](lib/brand/canon.schema.ts:153) |
| `fonts` must be unique per role, and `resolveTokens` throws if any of the 4 roles is missing | [canon.schema.ts:166](lib/brand/canon.schema.ts:166), [tokens.ts:38](lib/brand/tokens.ts:38) |

So a stale/invalid field in a section you aren't even looking at blocks saving *every*
section. **This is the "save fails often" bug.**

### 0.2 The JSON textareas fail *silently*

`SliceJsonFacet` ([SliceJsonFacet.tsx:40](app/brand/canon/facets/SliceJsonFacet.tsx:40)) only calls `onChange` when the blob parses
**and** validates, on blur. If you typo a comma:

- your edit never reaches `draft`
- `dirty` stays `false`
- the **Save button stays disabled** and the bar says "No unsaved changes"

You typed, it looked fine, nothing was saved and nothing told you. Ethos / Voice /
Visual Identity / Agent Rules / Forbidden-colors are *all* edited this way today.

This is also the most likely explanation for "published changes don't show up" — the
publish path *does* call `revalidateTag('brand-canon','max')` and `router.refresh()`
([publish/route.ts:28](app/api/brand/canon/publish/route.ts:28), [CanonEditor.tsx:76](app/brand/canon/CanonEditor.tsx:76)), so a genuine cache bug is the
second suspect, not the first. Publishing an unchanged draft looks exactly like a
failed refresh.

### 0.3 The canon is one document with one save button

There is one draft row, one `PUT /api/brand/canon/draft` that replaces the entire
document, and one Publish. Two admins in two tabs will clobber each other, and there is
no way to say "just fix the Ethos copy".

Everything below assumes we fix these three first.

---

## 1. The organizing idea

Read the seven asks side by side and almost all of them are **the same three shapes**:

| Shape | Appears in |
|---|---|
| **Illustrated rule** — do/don't + title + detail + a picture | Visual Identity (both columns), Color → Forbidden, Marks (use / never use) |
| **Two-sided comparison** — a labeled left vs. a labeled right | Ethos (means / cost), Voice (on-voice / off-voice) |
| **Specimen card** — an artifact + its spec sheet | Color swatches, Type use cases, Marks |

So the proposal is **not** seven bespoke redesigns. It is:

1. **One new canon primitive** — `GuideRule` — where the semantics genuinely match.
2. **A shared block kit** (`app/brand/guide/blocks/`) of ~9 view components.
3. **A mirrored field kit** (`app/brand/canon/fields/`) of typed editors — no more JSON textareas.
4. Each subtab becomes a **composition** of those blocks.

The scalability test: adding "Photography" or "Iconography" as an 8th subtab later
should be *compose existing blocks + one schema slice*, not *write a new tab*.

### 1.1 The one new primitive

```ts
// lib/brand/canon.schema.ts
const guideRuleSchema = z.object({
  id: z.string(),                          // stable — powers diffing + reorder
  polarity: z.enum(["do", "dont"]),
  title: z.string(),                       // the rule, in one line
  detail: z.string().optional(),           // the why / the nuance
  assetId: z.string().uuid().optional(),   // → brand_assets row
  caption: z.string().optional(),          // what the image is showing
});
```

Used by `visual.rules`, `color.forbidden`, and each mark's `usage`. Rendered by one
`<RuleCard>`, edited by one `<RuleListField>`.

Ethos and Voice-rewrites keep their own types (means/cost and on/off are not the same
relationship as do/don't) but **share the `<ComparisonCard>` component** — which is
exactly what you asked for in both cases.

### 1.2 The guide eats its own cooking

The Brand Guide must render *itself* from the canon it configures. No hand-coded color,
no hand-coded family. Today that's half true.

**Color — already correct.** Guide views use `bg-brand-*` / `text-brand-*`, which resolve
from the `--color-brand-*` custom properties `BrandStyle` emits from the published canon.
Change a palette hex, the guide restyles. Keep this exactly as it is.

**Type — inert.** `--font-brand-display` is **hardcoded** to Marcellus:

```css
/* app/globals.css:74 */
--font-brand-display: var(--font-marcellus), "Marcellus", serif;
```

and `emitBrandCss` deliberately emits *only* colors ([tokens.ts:46](lib/brand/tokens.ts:46)). So an admin can
assign Lato to the `display` role in `TypeFacet`, save, publish — and the guide still
renders Marcellus. **The type editor currently does nothing.** This is a live bug, not
just an architectural wish.

The reason for the original omission is real: `BrandStyle` writes an unlayered `:root{}`
block, which beats `@layer theme`, so emitting bare family stacks would break the
next/font chain and silently fall back to a generic serif. The fix is to emit the
*mapping* rather than the stack — keep pointing at the loaded face, just let the canon
choose which one:

```css
:root{ --font-brand-display: var(--font-lato), "Lato", sans-serif; }
```

One line per role, generated from `canon.fonts`. For uploaded faces (§3.5) the chain
points at the `@font-face` family instead. `globals.css` keeps its four lines as
build-time defaults; the canon overrides at runtime.

⚠️ **Verify by computed style, not by a green build.** This repo has already been bitten
once by dead token classes that passed `npm run verify` *and* the no-raw-colors grep
while rendering nothing. Tailwind v4 only emits palette vars that are actually used, and
a broken var chain fails silently. The acceptance test is reading
`getComputedStyle(el).fontFamily` in the browser, not compiling.

**Type scale — a deliberate half-measure.** Sizes are hardcoded per component today
(`text-3xl sm:text-4xl`, `text-lg`, …). Once Type defines use cases with real sizes
(§3.5), the guide's own headings should read from them. But I'd bind **family and weight
only**, and keep sizes on the app's type scale, with the canon's use-case sizes rendered
as *specimens* rather than applied to the page chrome. Reason: a fat-fingered `320px` in
a canon field should not be able to break the page that edits it. If you'd rather the
guide fully assume its own scale, that's a defensible call — it just needs a validated
range on the size fields.

### 1.3 Stable `id`s everywhere

Every list item in the canon (`values`, `voice.sliders`, `voice.rewrites`, `palette`,
`fonts`, `marks`, rules) gains a stable `id`. This is load-bearing for three separate
asks:

- auto-changelog can say "changed value 3's cost" instead of "values array differs"
- reordering isn't reported as N changes
- assets can be reverse-looked-up ("this graphic is used by Visual Identity rule 4")

---

## 2. The block kit

`app/brand/guide/blocks/` — brand-namespaced tokens only (`text-brand-*`, `bg-brand-*`),
per the existing guide convention.

| Block | Purpose |
|---|---|
| `GuideSection` | *(exists)* intro prose + content |
| `SubHead` | kicker + description, with a real visual hierarchy between the two |
| `SpecCard` | titled card with **labeled** field rows |
| `ComparisonCard` | labeled left column vs labeled right column; stacks on mobile |
| `RuleGrid` | Do column / Don't column |
| `RuleCard` | polarity chip + title + detail + image box |
| `AssetImage` | resolves an `assetId` → sized, `object-contain`, aspect-locked box. **One place** that owns "images never blow up the layout" |
| `SwatchCard` | color + use case + every code, each copyable |
| `SpecimenCard` | type specimen rendered at a real size/weight |
| `MarkCard` | artwork box + purpose + usage rules + per-format download |

`app/brand/canon/fields/` — app tokens (this is ops chrome, not brand skin).

`TextField` · `TextAreaField` · `CardListField` · `RuleListField` · `PairListField` ·
`SliderField` · `WordListField` · `AssetPickerField` (inline upload + pick from library)

Every field is typed, validates its own slice, and **cannot silently swallow an edit**.

---

## 3. Per-subtab designs

### 3.1 Ethos

- One `SpecCard` per value. Heading `1 · Story before ship`, then two rows with
  **matching labels**: `WHAT IT MEANS` and `THE COST` — same weight, same treatment.
  (Today `means` is unlabeled body text and only `cost` gets a label.)
- Schema: unchanged apart from `id`.
- Editor: `CardListField` — title / means / cost, add · remove · reorder.

### 3.2 Voice

**Calibration.** `SliderField` per axis:

```
Playful ─────────●──────── Reserved          40
Warm wit, never zany
```

- numeric readout (`40`) on the right of the track, with tick marks at 0/25/50/75/100
- the **note becomes the primary readable line** (body size, `text-brand-content`) and
  the left/right pole labels drop to small muted text at the track ends — inverting
  today's hierarchy, where both are identical `text-xs text-brand-content-muted`

**Vocabulary.** Promote the buried `Lean on: … / Never: …` line into its own
sub-section with two chip panels — `Lean on` (neutral) and `Never` (accent). Real
sub-head, real position.

Sits **between Calibration and In practice** (Q7). That ordering reads as an argument:
here's the register → here are the words that hit it → here's both applied to real copy.
Vocabulary also flows into the Agent Rules markdown.

**In practice.** Convert top/bottom → **left/right**. `ComparisonCard` per rewrite:
context as the row label, `✓ On-voice` in the left column, `✕ Off-voice` in the right,
aligned so the difference reads horizontally. Stacks on mobile.

### 3.3 Visual Identity

- `RuleGrid`: a **Do** column and a **Don't** column, each a stack of `RuleCard`s with
  an image box. No more six undifferentiated bullets that mix musts and must-nots.
- Schema: `illustrationLaw.rules: string[]` → `visual.rules: GuideRule[]`. Migration
  converts the six existing strings to `{polarity, title}` with no image; `illustrationLaw`
  stays readable (optional) through the transition.
- Editor: `RuleListField` with inline image upload → lands in `brand_assets` as kind
  `example`, immediately usable.

### 3.4 Color — the heavy one

Three stacked sections with an explicit dependency arrow between the first two.

**A · Palette** (the ink deck). `SwatchCard` grid, grouped by tier:

- **Core** — Indigo, Paper, Seal Red, Camphor Tan
- **Neutrals** — the UI steps

Each card: large swatch · name · **use case** (prominent, it's the whole point) ·
a codes row where `HEX` `RGB` `CMYK` `PMS` are **each individually copyable** plus
"copy all" · a small mono `key` chip · and **"Drives: canvas, line"** listing the theme
roles bound to it.

**On `paper-2` vs `Paper 2 (derived)`:** these are not two versions of anything.
`key` (`paper-2`) is the stable slug that `roleMap` binds to; `name` (`Paper 2 (derived)`)
is the human label. The `(derived)` suffix is misleading — these colors are
hand-authored UI neutrals, not computed from anything. **Fix:** add
`tier: "core" | "neutral"` to the color schema, drop `(derived)` from the names, and
show the slug as a small technical chip rather than baking it into the display name.

**B · Theme** (the 13 roles). One row per role showing light and dark side by side, and
crucially **where each value comes from** — on *both* sides:

```
canvas        ← Paper            ← Ink Ground
line-strong   ← Camphor Tan      ← Camphor Shadow
secondary     ⚠ detached #8d7f5f ← Camphor Tan
```

Selecting a palette swatch highlights every role it drives, and selecting a role
highlights its source swatch — the bidirectional link you asked to be made apparent.
The mapping logic already exists inline in `PaletteFacet`; it gets promoted to a pure,
tested `lib/brand/paletteLinks.ts` used by **both** the view and the editor.

Usage ratios render as a single 60/30/10 proportion bar instead of a `· 60%` suffix.

#### Dark mode binds to the palette (Q6)

Today dark is asymmetric and invisible: `roleMap.dark` is a *sparse* record of raw hex
overrides, and every unset role is computed at render time by `deriveDarkPalette()`. So
dark-mode colors exist nowhere in the palette, can't be named, can't be given a use case,
and can't be reasoned about. The Color tab doesn't even show them.

**Change:** `roleMap.dark` becomes the same shape as `roleMap.light` — a **complete**
record where each role holds a palette key (or a raw hex, flagged `detached`). Dark
becomes a first-class mapping, not a fallback.

`deriveDarkPalette` stops being a runtime resolver and becomes an **editor-time
suggestion tool**:

```ts
// lib/brand/suggestDark.ts  (pure)
suggestDarkRoles(light, palette): Record<RoleName, {
  derived: string          // what the HSL treatment produces
  nearestKey: string       // closest existing palette color
  distance: number         // OKLab ΔE
  verdict: "snap" | "add"  // below/above the threshold
}>
```

Driven by an **Auto-derive dark mode** button that runs once, shows its work, and lets
you accept per role. Where a palette color is genuinely close it snaps to that key; where
nothing is close it offers to **add a new palette entry** pre-filled with the derived hex
and a suggested name + use case. Nearest-match uses **OKLab ΔE**, not RGB distance —
RGB euclidean would happily call a warm tan "close to" a cool blue-grey.

`resolveTokens` gets simpler as a result: `resolveDark(canon)` mirrors `resolveLight(canon)`
and the runtime derivation disappears from the render path entirely.

#### Why mechanical derivation isn't the answer

Running the current HSL derivation against the seed and matching each result to its
nearest existing palette color in OKLab gives this:

| Role | Derived | Nearest | ΔE | |
|---|---|---|---|---|
| accent | `#e44e61` | Seal Red | 0.151 | no match |
| canvas | `#161b27` | Indigo | 0.124 | no match |
| primary | `#6e86c4` | Content Ink Muted | 0.113 | no match |
| content-muted | `#939ebe` | Camphor Tan | 0.099 | marginal |
| surface | `#1d2434` | Indigo | 0.087 | marginal |
| content | `#bfc6d9` | Paper 3 | 0.074 | marginal |
| line-strong · surface-raised · high-contrast · line | — | Indigo / Content Ink / Paper 2 | 0.028–0.047 | snap |
| secondary · on-primary · on-accent | — | exact | 0.000 | snap |

Above ~0.10 is a visible shift; 0.07–0.10 is marginal — and the marginal ones are the
dangerous ones, because Paper 3 and Camphor Tan are **warm** while the derived values are
**cool blue-greys**. Snapping those would visibly warm dark-mode text.

Taken at face value this says "add eight new colors" — a parallel neutral ramp with
nothing in common with the light identity. **The inversion in the previous section beats
it on every axis**: five new colors instead of eight, seven roles bound to colors the
brand already owns, and a dark mode that visibly *is* the brand rather than a greyscale
shadow of it.

The lesson for the tool, not the palette: **auto-derive is a suggestion engine, never an
authority.** It optimises one role at a time against a mechanical HSL treatment, and it
cannot see that Indigo-and-Paper already contain a perfectly good dark mode. It stays in
the editor as a starting point with a human accepting each row — which is exactly how
§3.4-B specifies it.

New entries carry names, use cases, and (eventually) print codes. I'd resist adding a
`mode: light | dark` field: it's a use-case description, not a constraint, and several
colors legitimately serve both — Indigo, Paper, Paper 2 and Camphor Tan now all do.

#### ⚠️ Dark mode today ships failing contrast

While computing the above I checked `on-primary` / `on-accent`, which the derivation
treats as `keep` — they hold Paper while the fill beneath them lightens:

| Pair (current runtime dark mode) | Contrast | WCAG |
|---|---|---|
| Paper `#f5f0e6` on primary `#6e86c4` | **3.15** | fails AA |
| Paper `#f5f0e6` on accent `#e44e61` | **3.32** | fails AA |

Every dark-mode primary and accent button label is below AA for normal text right now.
It's invisible because dark mode is computed at render time and the Color tab never
displays it — which is the strongest argument for making dark a real, inspectable
mapping. The `keep` treatment is simply wrong for `on-*` roles: when the fill lifts,
the label must darken, not stay put.

#### The dark palette — settled

Dark mode **inverts Indigo and Paper** rather than introducing a parallel neutral ramp.
Seven of the thirteen dark roles bind to colors the brand already owns; only five new
entries are needed. The four Tier-1 colors are **untouched**.

| Key | Hex | Name | Serves (dark roles) | |
|---|---|---|---|---|
| `midnight` | `#131b2f` | Midnight | canvas · on-accent | new |
| `indigo` | `#26355d` | Indigo | **surface** · on-primary | existing |
| `indigo-2` | `#364672` | Indigo 2 | surface-raised · line | new |
| `indigo-3` | `#4b5c8b` | Indigo 3 | line-strong | new |
| `paper` | `#f5f0e6` | Paper | **primary** · high-contrast | existing |
| `paper-2` | `#efe8da` | Paper 2 | content | existing |
| `chalk` | `#afb7ca` | Chalk | content-muted | new |
| `vermilion` | `#f37149` | Vermilion | accent | new |
| `camphor` | `#b3a585` | Camphor Tan | secondary | existing |

**Why Indigo is the `surface` and not the `canvas`.** This is the one structural
constraint, and it's worth stating because "just use Indigo as the background" is the
obvious first instinct. Dark-mode elevation must run monotonically — canvas darkest,
raised lightest. Indigo sits at relative luminance 3.7. Make it the floor and every
elevated surface must be a *lighter* indigo; by the raised step you're at `#3c5086`,
38% saturation — a vivid blue that reads as an element rather than a ground and competes
with content. Push the surfaces darker instead and elevation runs backwards.

Put one deeper shade (Midnight) beneath it and the ramp behaves: `1.1 → 3.7 → 6.4`.
Indigo still dominates the screen — every card, panel and bar is Indigo — there is just
a slightly deeper shade behind them.

**What doesn't invert, in any arrangement:**

- **Seal Red as the dark accent.** 1.69:1 on Indigo, and the canon's own `colorForbidden`
  already bans "Seal Red on Indigo for text of any size (fails contrast, vibrates)". A
  brightened accent is required no matter how the grounds are arranged.
- **Camphor Tan as muted text.** 4.94 on Indigo, so it passes on the canvas — but 4.15 on
  surface and 3.22 on raised. Muted text needs its own value (Chalk).

**On the naming.** The palette names its materials in **English** — Paper, not washi;
Seal Red, not shu; Indigo, not ai. `Midnight` and `Chalk` keep that idiom; Chalk is the
natural counterpart to ink once the ground goes dark. `Indigo 2` / `Indigo 3` follow the
existing `Paper 2` / `Paper 3` convention — a base color with numbered steps running away
from the ground. `Vermilion` is the English pigment name for bright cinnabar seal ink,
making it a sibling of Seal Red rather than a washed-out copy.

`tier: "neutral"` for Midnight, Indigo 2, Indigo 3 and Chalk; `tier: "core"` for
Vermilion, a genuine brand-color extension. CMYK/PMS codes can follow later — these are
screen colors first.

#### Contrast fixes applied

Auditing both modes end-to-end turned up one more failure beyond the `on-*` bug, in
**light** mode:

| Fix | Before | After |
|---|---|---|
| `content-muted` **`#6b6f7d` → `#575a66`** (light) | 4.41 / 4.11 / **3.43** — failed AA on *all three* light grounds | 6.04 / 5.63 / 4.70 |
| dark `on-primary` → **Indigo**, `on-accent` → **Midnight** | 3.15 / 3.32 — failed AA | 10.57 / 5.93 |
| dark `accent` → **Vermilion `#f37149`** | Seal Red was 1.69 on Indigo — canon-forbidden | 5.93 / 4.15 / 3.19 |

`content-muted` is the one that matters most day to day — it's the muted body copy used
throughout the guide, and it has been below AA on every surface. Darkening it to
`#575a66` is the minimum change that clears all three; the hue and its 8% saturation are
unchanged, so it still reads as the same color.

**Accent is held to AA-large (3:1) on the two lighter dark grounds, deliberately.**
Indigo grounds are lighter than a neutral ramp would be, which squeezes the accent from
below: clearing full 4.5:1 on the raised surface requires lightening Vermilion to about
`#ffa070`, a pale peach that abandons the seal character entirely. Compressing the
elevation ramp doesn't rescue it either — even at `#2a375c`, where the surface step is a
barely-visible 1.03:1, a true vermilion only reaches 4.04.

3:1 is the correct target here rather than a concession: the canon **already** restricts
this color to large text and small areas — `Seal Red ≤5% of any composition` and
`Seal Red body text below 18px` is a forbidden pairing. A color that is never small body
text by rule is governed by the large-text threshold, and `#f37149` clears it.

For Vermilion's hue I searched the red→orange band rather than just lightening Seal Red.
Staying at hue 352 requires `#e97282`, which reads rosé. Hue 14 at 88% saturation stays
genuinely vermilion. (Full saturation `#ff6929` also works — it just reads like a system
warning.)

**Result: zero failures against the applicable threshold across every text and label
pairing in both modes.**

#### Flagged, deliberately not fixed

Two pre-existing issues that can't be fixed without touching the four protected colors:

- **`secondary` (Camphor Tan) as text is 2.14:1 on Paper** — unreadable. Camphor Tan is
  off-limits, and the honest fix isn't a color change anyway: `secondary` should be a
  *fill* role, not a text role. Needs a usage audit in phase 3 — if nothing renders text
  in `text-brand-secondary`, this is a non-issue and the role's use case should say so.
- **Borders sit below the 3:1 non-text target** — `line` at 1.20, `line-strong` at 1.99.
  `line` resolves to Paper 3 and `line-strong` to Camphor Tan. WCAG 1.4.11 governs
  meaningful UI boundaries, not decorative separators, so a hairline card border at 1.20
  is a defensible choice for a paper-first brand. But `line-strong` is named for doing
  real work and doesn't. Your call whether to re-bind it in phase 3.

#### Snapping needs a collision guard

One implementation note the derivation exposed: `surface` (ΔE 0.087) and `surface-raised`
(ΔE 0.043) both snap to **Indigo**. Taken independently each match is defensible; applied
together they flatten two elevation levels into one and the raised surface stops reading
as raised. The auto-derive tool must refuse to snap two roles in a known-distinct pair to
the same palette key and escalate the second to `add`.

The distinct pairs are `canvas`/`surface`, `surface`/`surface-raised`, and
`surface-raised`/`line-strong`. Note that `surface-raised`/`line` is **not** one of them —
they share a key in both modes by design (Paper 3 in light, Indigo 2 in dark), exactly as
the current light palette already does. The guard encodes which pairs carry meaning, not
a blanket uniqueness rule.

#### Light-palette cleanup, same migration

Four existing entries get renamed with **no hex change** — the `(derived)` suffix is
misleading (they're hand-authored, not computed) and now that dark mode has real
palette colors it would be actively confusing:

| Key | Was | Now |
|---|---|---|
| `paper-2` | Paper 2 (derived) | Paper 2 |
| `paper-3` | Paper 3 (derived) | Paper 3 |
| `content` | Content Ink (derived) | Content Ink |
| `content-muted` | Content Ink Muted (derived) | Content Ink Muted |

`content-muted` also changes hex per the contrast fix above. The other three are
name-only.

**Migration:** phase 3 ships a migration that writes the expanded 13-color palette, the
renames, the `content-muted` hex fix, and the complete `roleMap.dark`, then drops the
runtime fallback. Human-gated as usual. Names and hexes are settled, so it's writable as
soon as phase 3 starts.

**Final palette — 13 colors, 5 new.**

| Tier-1 (untouched) | Light neutrals | New |
|---|---|---|
| Indigo `#26355d` | Paper 2 `#efe8da` | Midnight `#131b2f` |
| Paper `#f5f0e6` | Paper 3 `#ded5c1` | Indigo 2 `#364672` |
| Seal Red `#ad1a2d` | Content Ink `#3a4256` | Indigo 3 `#4b5c8b` |
| Camphor Tan `#b3a585` | Content Ink Muted `#575a66` ← hex fixed | Chalk `#afb7ca` |
| | | Vermilion `#f37149` |

**Complete `roleMap.dark`** — every role bound to a palette key, zero detached hexes,
fully symmetric with light:

```
canvas→midnight   surface→indigo        surface-raised→indigo-2
line→indigo-2     line-strong→indigo-3
primary→paper     on-primary→indigo     high-contrast→paper
content→paper-2   content-muted→chalk
accent→vermilion  on-accent→midnight    secondary→camphor
```

**C · Forbidden.** Same `RuleGrid` as Visual Identity, don't-column only, each with an
image box showing the violation. The four image slots ship **empty** (Q8) — the card
renders a neutral placeholder until artwork is uploaded, so the structure lands now and
the graphics follow.

### 3.5 Type

**A · Faces.** One card per registered face: family · source badge
(`Bundled` / `Uploaded` / `System`) · weight chips · specimen · licensing note.

**B · Use cases.** New `typeUseCases[]`, grouped by medium:

```ts
{ id, medium: "screen" | "print" | "packaging" | "signage",
  element: "Page title", fontRole: "display", weight: 400,
  size: "32/38", tracking: "+4%", notes?: string }
```

Rendered as a grouped table where **each row renders a live specimen at its actual
size and weight** — so "on a webpage" and "on a printed marketing asset" are things you
*see*, not a line you parse. Replaces today's single run-on
`display · Marcellus · weights 400 · <note>` line.

**C · Adding fonts.** Extend the font schema with
`source: "bundled" | "uploaded" | "system"` and `assetIds?: string[]`.

- **Uploaded** — `.woff2`/`.woff`/`.ttf`/`.otf` upload as `brand_assets` kind `font`;
  a new `BrandFontFace` server component (sibling of `BrandStyle`) emits `@font-face`
  from approved font assets. They appear in the Assets tab automatically.
- **System** — a family string with no file, e.g. `ui-monospace, SFMono-Regular, …`.

**Keep the four token roles** (`display`/`body`/`wordmark`/`script`) as-is — they're what
`resolveTokens`/`emitBrandCss` bind to, and widening that enum ripples into the whole
app skin. *Registering* a face is now open-ended; *assigning* a face to one of the four
roles stays closed. That gets you the flexibility with none of the token churn.

**Font hosting:** resolved by Q3 — the bucket goes private (§5.1), so font binaries are
served through the session-gated proxy route and are never reachable anonymously. That
removes the redistribution concern for licensed faces. `@font-face` is emitted with
`src: url(/api/brand/assets/<id>/file)`, which is exactly why the proxy route is
preferred over expiring signed URLs.

### 3.6 Marks

Three sections — **Wordmarks** · **Chops** · **Logos** — each a grid of `MarkCard`.

Each card:
- artwork box — fixed aspect, `object-contain`, neutral ground; **one** `<MarkArtwork>`
  component so a 4000px PNG and a 60px SVG both land identically
- title + purpose
- `Use for` / `Never` as `GuideRule`s (reusing 3.1's primitive)
- clearspace + minimum size
- **format chips with per-format download** — SVG · PNG · PDF

Everything sits flat on the card — no click-to-reveal (Q8). Three sections of these will
be a long page, and that's the right trade: a spec sheet you scroll beats a spec sheet
you have to interrogate.

Schema: each mark variant gains `assetIds: string[]` (one variant → many files, one per
format) and `usage: GuideRule[]`. The guide stops resolving three hardcoded
`kind`+`variant="default"` lookups ([guide/page.tsx:45](app/brand/guide/page.tsx:45)) and reads the
canon's asset references instead — which is what makes "add a second wordmark cut"
possible without a code change.

Uploads already flow through the Assets API, so they land in the library for free; the
Assets tab gains kind-grouping and a "used by" reverse lookup so deletions are safe.

### 3.7 Agent Rules

`lib/brand/brief.ts` (plain text today) becomes `lib/brand/markdown.ts`:

```ts
compileBrandMarkdown(canon): {
  sections: { key: GuideSectionKey | "technical", heading: string, markdown: string }[]
  full: string
}
```

- Markdown-first rendering: minimal chrome, `whitespace-pre-wrap`, section rules.
- **Copy per section** + **Copy all** + **Download `.md`**.
- Sections mirror the subtabs 1:1, plus one `Technical rules for agents` section
  (`neverList` / `precedence` / `hardRules` / new agent-only rules) that exists nowhere else.
- Because it compiles from the canon, it can never drift from what the tabs show.

---

## 4. Save · publish · changelog · refresh

### 4.1 Section-scoped saves

New `lib/brand/canonSections.ts` — the one shared map from subtab → the canon keys it
owns (promoting `canonSlices.ts`, used by client *and* server):

```ts
PATCH /api/brand/canon/draft   { section, patch }
```

Server loads the draft, merges the patch, and validates **only the touched keys** via
`canonSchema.pick(...)`. Whole-document `canonSchema.parse` moves to **publish only**.

This single change kills the entire "editing Ethos fails because `naming` is stale"
class of failure.

### 4.2 Publish-time validation, readable

`validateCanonForPublish(doc) → { ok } | { issues: { section, path, message }[] }`,
rendered grouped by subtab with a jump link to the offending tab. No raw Zod dumps.

### 4.3 Autosave

Debounced autosave per section (~800 ms after last keystroke, plus on tab-switch and
blur), with a per-section saved/saving/error indicator. `Save` stays as a manual
escape hatch. Combined with typed fields, "did my edit take?" stops being a question.

### 4.4 Publish stays whole-document — but shows you what changed

Publish snapshots one canon; per-section publishing would fork the document into
independently-versioned parts and I'd recommend against it. Instead the publish bar
lists **which sections differ from the live version** and the confirm dialog shows the
generated changelog before you commit. *(Q2.)*

### 4.5 Auto-generated changelog

New pure module `lib/brand/diffCanon.ts`:

```ts
diffCanon(prev, next): ChangeEntry[]
ChangeEntry = { section, kind: "added"|"changed"|"removed", label, path, before?, after? }
```

Stable `id`s (§1.3) make this produce human sentences —
*"Color · changed Seal Red hex #ad1a2d → #a51829"*, *"Visual Identity · added don't-rule
'No drop shadows'"* — instead of array diffs.

- Migration: `alter table brand_canon_versions add column change_entries jsonb`
- Publish stores structured entries **and** a rendered text changelog
- The admin's free-text note becomes optional *extra* context, not the whole record
- History tab renders entries grouped by subtab, expandable

### 4.6 Refresh after publish

The current path already does the right things (`revalidateTag('brand-canon','max')` +
`router.refresh()`), and the Next 16 two-arg `revalidateTag` signature is correct. Two
changes make it robust by construction rather than by timing:

1. Move publish to a **Server Action** using `updateTag()` — Next 16's read-your-writes
   primitive, designed for exactly this — instead of a route handler + client refetch race.
2. Add a `revalidatePath('/brand/guide')` belt-and-braces.

But: **I don't want to claim this is the fix before reproducing it.** Given §0.2, the
first thing to verify is whether the "didn't refresh" reports are actually "the draft
never saved". The instrumented autosave in §4.3 will make that distinguishable.

### 4.7 Delete the Live Preview card

Agreed — it previews a fixed swatch grid regardless of which tab you're on, and it's
irrelevant on five of seven tabs. **Remove `BrandPreview` entirely.** The replacement is
better by construction: because the editors use typed fields and (for Color and Type)
the *same* block components as the view, the edit surface *is* the preview.

---

## 5. Assets

- Kind check constraint gains `font` and `example`.
- `brand_assets` gains `title text` and `alt_text text` — needed for accessible images
  and for do/don't card captions.
- Assets tab: grouped by kind, with a **"used by"** reverse lookup computed from the
  canon (which rule / mark / font references each asset), so deleting is safe.

### 5.1 Making the bucket private (Q3)

The bucket flips to private wholesale. That's a small change with a few real
consequences, all contained — `publicUrlFor` has exactly **four** call sites plus
`resolveAsset` and one test.

**Serving.** New session-gated route:

```
GET /api/brand/assets/[id]/file   → streams the object via the admin client
```

`publicUrlFor(path)` → `assetFileUrl(id)` = `/api/brand/assets/${id}/file`.

I'd take a **proxy route over signed URLs** here. Signed URLs expire, which breaks three
things this design needs: `@font-face src` (§3.5) that must stay valid for the life of a
cached page, `<img src>` inside a cached RSC payload, and stable download links on mark
cards. A proxy route gives a permanent URL, one auth gate, and normal browser caching.
Cost is that image bytes flow through the app — fine at brand-asset volume and
frequency.

**Cascading changes:**

- Migration: `update storage.buckets set public = false where id = 'brand-assets'`,
  plus dropping the anon-read storage policy. Service-role reads only.
- The `brand_assets` **table** RLS policy `brand_assets_read_approved` (anon SELECT of
  approved rows) also goes — nothing anonymous reads this any more.
- [guide/page.tsx:21](app/brand/guide/page.tsx:21)'s `createCookielessAssetClient()` can be deleted. It only
  existed to read approved assets anonymously; the whole `/brand` area is already
  session-gated by the layout, so it reads through the admin client like everything else.
- Callers to update: `MarksEditor`, `AssetsView`, `LabelsWorkbench`, `resolveAsset`,
  `assets.test.ts`.

**Note for later:** this makes brand assets unreachable from a future public site
without new work — which is the intended trade. When that site exists, a second
**public** bucket takes the subset that should be exposed, and an asset gains a
`visibility` flag choosing which bucket it lands in. Not built now.

Worth doing in **phase 0**, before anything starts referencing asset URLs — retrofitting
the URL shape after Visual Identity, Marks and Type all depend on it is strictly worse.

### 5.2 Canon migration policy (Q4)

Each phase ships a migration that rewrites the stored draft + published rows into the
new shapes and **removes** what it replaced. Specifically:

- `illustrationLaw` → `visual.rules` (phase 2), old key dropped
- the dead `visibility.mission` key dropped, and `sectionKeySchema` loses it
- palette `name` values lose `(derived)`; `tier` added (phase 3)
- `marks[].variants[]` gains `assetIds`; the three hardcoded kind lookups go (phase 4)

There's one published row and one draft, so the blast radius is two JSON documents.
Per repo convention these are human-gated — written as migration files, applied by you
after a backup, never auto-applied by an agent.

---

## 6. Sequencing

Reliability first, then cheap readability wins, then the schema-heavy tabs.

| Phase | Scope | Why here |
|---|---|---|
| **0 · Foundation** | stable `id`s · `canonSections.ts` · section-scoped PATCH · publish validation report · `diffCanon` + `change_entries` · autosave · delete `BrandPreview` · **private bucket + asset proxy route** (§5.1) · asset kinds `font`/`example` | Nothing else is safe to build on a save path that fails at random — and every later phase references asset URLs, so the URL shape must settle first |
| **1 · Ethos + Voice** | block kit + `CardListField`/`SliderField`/`PairListField` | Lowest schema churn, highest readability win — proves the kit |
| **2 · Visual Identity + Forbidden** | `GuideRule` + `RuleGrid`/`RuleCard` + `example` assets | Introduces the illustrated-rule primitive once, for two tabs |
| **3 · Color** | tiers · all codes copyable · palette↔theme linkage · **palette expansion + symmetric `roleMap.dark` + auto-derive tool** (§3.4-B) | Biggest single-tab rework; the dark-mode migration is the riskiest single step in the plan |
| **4 · Marks** | asset refs · multi-format · three sections | Depends on `GuideRule` (phase 2) |
| **5 · Type** | **canon-driven `--font-brand-*` emission** (§1.2) · use cases · uploaded/system fonts · `@font-face` | Depends on asset-kind migration (phase 0). The font-emission fix is the first thing in this phase — everything else in Type is unverifiable until the editor stops being inert |
| **6 · Agent Rules** | markdown compile + copy | Compiles *from* everything above — must be last |

Each phase is independently shippable and independently reviewable.

Rough size: phase 0 ≈ 12–14 files (grew with the bucket work), phases 1–2 ≈ 6–8 each,
phase 3 ≈ 12 (grew with the dark-mode rework), phase 4 ≈ 8, phase 5 ≈ 12, phase 6 ≈ 4.
Per the repo's tiering, phases 1, 2 and 6 are inline work; 0, 3, 4, 5 warrant written
plans.

**Verification note for phases 3 and 5.** Both change CSS custom properties, and this
repo has been burned before by token classes that pass `npm run verify` *and* the
no-raw-colors grep while rendering nothing — Tailwind v4 only emits palette vars that
are actually used, and a broken `var()` chain fails silently. Neither phase is done on a
green build. Both need a browser check reading `getComputedStyle()` for the affected
roles in light **and** dark.

---

## 7. Still open

Nothing blocking — Q1–Q8 are resolved above. Four things to settle **during** the
phases they belong to rather than now:

0. **Whether `secondary` (Camphor Tan) is ever used as text**, and whether `line-strong`
   should be re-bound to clear the 3:1 border target (§3.4-B, "flagged"). Both need a
   usage audit in phase 3, and both touch protected colors, so they're your call.

1. **Whether the "publish doesn't refresh" report survives the autosave fix.** §0.2 gives
   a complete alternative explanation (the draft never saved), and the current publish
   path already does the correct Next 16 revalidation. Phase 0's instrumented autosave
   makes the two distinguishable. If it still misbehaves afterward, the Server Action +
   `updateTag()` change in §4.6 is the fix; if not, that change is unnecessary churn.

2. **Whether Voice's calibration `pos` should stay 0–100.** Adding a numeric readout
   makes the scale user-visible for the first time. 0–100 is fine, but if you'd rather
   the guide read `3 of 5` or `−2 … +2`, that's a schema decision better made once the
   slider is on screen than in the abstract.

3. **How far the guide should assume its own type scale** (§1.2). Family and weight are
   canon-driven either way. The question is whether canon-defined *sizes* drive the
   guide's own headings, or stay rendered as specimens only. Easier to judge once the
   Type use-case table exists in phase 5.
