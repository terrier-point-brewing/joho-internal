# Brand Template System — Phase 2 proposal

Companion to `docs/brand-template-system-phase1-findings.md`. Decisions from the
owner (2026-07-30) are folded in and marked **[locked]**.

**Status: paused after Phase B.** Phases 0, A and B are built and committed;
C–I are not started. Full progress record, and the state to be careful of when
resuming, in **§7**. What blocks Phase C is in **§8**.

---

## ⚠️ 0. A live regression to fix first — not a proposal item

`20260811_brand_labels.sql` was applied by hand **after** `20260903_brand_assets_private.sql`.
Both rewrite the `brand_assets.kind` check constraint from a full list, and
20260811's list is the older one. Applied in that order it does:

```sql
alter table public.brand_assets drop constraint if exists brand_assets_kind_check;
alter table public.brand_assets add constraint brand_assets_kind_check
  check (kind in ('logo','wordmark','chop_glyph','texture','icon','photo','label_art'));
```

which **drops `font` and `example`**. Those two kinds are live: `example` backs the
do/don't imagery on Visual Identity and Color (`guideRuleSchema.assetId`), `font`
backs uploaded typefaces (`brandFontSchema.assetIds`). Any upload of either now
fails a check violation, and `BRAND_ASSET_KINDS` in `lib/brand/assets.ts` no
longer matches the database.

I could not verify this read-only — PostgREST exposes no SQL RPC and confirming
it would require a write. Verify with:

```sql
select pg_get_constraintdef(oid) from pg_constraint where conname = 'brand_assets_kind_check';
```

The fix is one idempotent migration that restates the union of both lists
(`logo, wordmark, chop_glyph, texture, icon, photo, font, example, label_art`).
Harmless if the constraint is already correct. **Recommend shipping this on its
own, ahead of any template work.**

---

## 1. What is kept, extended, or migrated

| Existing | Disposition | Why |
|---|---|---|
| `brand_canon_versions` + the whole canon/guide/editor stack | **Keep. Extend, don't fork.** | It is already the Foundations layer: versioned, diffed, section-scoped-editable, immutable once archived. |
| `brand_tokens` (proposed in the brief) | **Do not create.** | It would fork the canon. Colors already carry `hex`/`cmyk`/`tier`/`role`; roles already bind semantically. The two genuine gaps (clearspace, cap-height ratios) are two new canon fields, not a new table. |
| `brand_assets` + private bucket + `/api/brand/assets/[id]/file` | **Keep unchanged.** | Path convention, the proxy-not-signed-URL decision, and the archive-before-approve flow all stay. |
| Asset versioning | **Not built** **[locked]** | Every upload already gets its own immutable `asset_id` and its own bytes. Outputs pin exact `asset_id`s; the guide declares which asset is current by referencing it explicitly (`marks[].variants[].assetIds` already works this way). No `version` column, no version-in-path. |
| `brand_labels` (0 rows, now applied) | **Keep and extend.** | Becomes the per-beer record that templates are launched from. |
| `/brand/releases` + `LabelsWorkbench` | **Keep and extend into the launch surface** **[locked]** | A release gains a Templates facet: pick a template, fill slots, render, review. |
| `lib/brand/markdown.ts` (Agent Rules compiler) | **Keep. Extend.** | Already compiles the canon to Markdown. Gains a JSON sibling for the AI-context endpoint. |
| `CAP.catalogRead` / scope `catalog` | **Reuse as-is.** | Already deliberately section-agnostic ("one scope for a capability reachable from two sections"). The menu's price bridge needs **no new scope** — just this grant. |
| `chop` / `labelChassis` / `naming` / `visibility` canon keys | **Migrate into editable sections.** | Currently owned by no guide subtab and editable nowhere. `labelChassis` is the label template's chassis spec; it cannot stay frozen. |

**No destructive change is proposed.** Nothing is dropped or renamed. The one
schema rewrite is the constraint fix in §0, which only *widens* an allowed set.

---

## 2. Schema

Four new tables. All follow the brand conventions: `brand_<noun>`, uuid pk,
`status` check, `created_by`/`created_at`, RLS enabled with a narrow SELECT and
**no write policy** (writes via `createSupabaseAdminClient()` behind
`requirePermission`). Migrations take full 14-digit stamps and carry the
`-- Human-gated (do not auto-apply).` footer.

```sql
-- Templates ARE versioned (unlike assets): a template is data, not a file, and
-- an output must be reproducible against the exact slot/constraint set it used.
create table public.brand_templates (
  id             uuid primary key default gen_random_uuid(),
  key            text not null,                 -- stable slug: 'beer-label'
  version        int  not null default 1,
  name           text not null,
  medium         text not null
                 check (medium in ('label','menu','social','apparel','signage','collateral')),
  status         text not null default 'draft'
                 check (status in ('draft','published','archived')),
  base_svg_path  text,                          -- brand-assets storage path
  slots          jsonb not null default '[]'::jsonb,
  constraints    jsonb not null default '{}'::jsonb,
  renditions     jsonb not null default '[]'::jsonb,
  notes          text,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  published_at   timestamptz,
  unique (key, version)
);
-- one published version per key
create unique index brand_templates_one_published
  on public.brand_templates (key) where status = 'published';

-- "chop tenant" is gone as a term. The canon's own chop spec already says what
-- rotates: "Glyph only — script or symbol per active motif family... The glyph
-- rotates per motif family." So it is an asset reference, not a character name.
create table public.brand_seasons (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,          -- "Season 1"
  chop_glyph_asset_id  uuid references public.brand_assets(id) on delete set null,
  background_hex       text,                   -- the seasonal motif's ground
  cultural_lean        text,
  motif_set            jsonb not null default '[]'::jsonb,  -- [{assetId, note}]
  season_logo_asset_id uuid references public.brand_assets(id) on delete set null,
  starts_at            date,
  ends_at              date,
  status               text not null default 'draft'
                       check (status in ('draft','active','archived')),
  created_by           uuid,
  created_at           timestamptz not null default now()
);

create table public.brand_outputs (
  id               uuid primary key default gen_random_uuid(),
  template_id      uuid not null references public.brand_templates(id) on delete restrict,
  template_version int  not null,
  rendition        text not null,
  season_id        uuid references public.brand_seasons(id) on delete set null,
  label_id         uuid references public.brand_labels(id) on delete set null,
  inputs           jsonb not null default '{}'::jsonb,   -- slot key -> value
  canon_version_id uuid references public.brand_canon_versions(id) on delete set null,
  tokens_snapshot  jsonb not null default '{}'::jsonb,   -- resolved role -> hex, actually used
  asset_refs       jsonb not null default '[]'::jsonb,   -- [{slot, assetId}] exact assets used
  status           text not null default 'draft'
                   check (status in ('draft','approved','exported')),
  source           text not null default 'human'
                   check (source in ('human','agent')),
  rendered_path    text,
  render_meta      jsonb not null default '{}'::jsonb,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  approved_at      timestamptz,
  exported_at      timestamptz
);
```

Reproducibility notes:

- `canon_version_id` is an FK **plus** `tokens_snapshot` holds the resolved
  values. Belt and braces on purpose: canon rows are normally archived, not
  deleted — but migration `20260813` did delete the v1.0 rows, so the FK alone
  is not a durable guarantee. The snapshot is the record of truth; the FK is the
  convenience join.
- `asset_refs` records the exact `asset_id` per slot, which is what makes
  "no asset versioning" **[locked]** sufficient.

Canon extensions (schema additions to `canon.schema.ts` + one data migration):

- `clearspace` — a structured rule per mark, replacing the free-text
  `markSchema.clearspace: string[]`.
- `brandFontSchema.capHeightRatio: number` — the cap-height spacing spec the
  target architecture requires; nothing today carries it.
- Cross-check: `cmyk`/`pms` exist on the 4 core colors only. The 9 neutrals need
  them before any CMYK print export is honest (see Open Question 3).

Storage — **one bucket, existing conventions preserved**:

```
brand-assets/                        (private, existing)
  <kind>/<uuid>.<ext>                (existing, unchanged)
  template/<key>/v<N>/base.svg       (new)
  output/<output-id>/<rendition>.<ext>  (new)
```

No new bucket, no backfill. `brand_templates` and `brand_seasons` start empty;
`brand_labels` is already empty.

---

## 3. Render stack recommendation

Requirements: server-side SVG slot substitution; PNG at declared pixel sizes;
PDF that is **vector, not a rasterized page** (apparel/signage are print-production);
CMYK-aware where feasible; runs on Vercel Fluid Compute (Node 24, 300s default).

**Recommended: `@resvg/resvg-js` for PNG + `pdfkit` with `svg-to-pdfkit` for PDF.**

| Path | Choice | Why |
|---|---|---|
| PNG | `@resvg/resvg-js` | Rust rasterizer, exact output dimensions, explicit font-buffer loading (no system-font guessing — critical when the render box has no fonts installed). ~7 MB prebuilt `linux-x64-gnu`, well within limits. |
| PDF | `pdfkit` + `svg-to-pdfkit` | **Keeps vectors.** Embeds real font files. `fillColor` accepts a 4-element array emitted as **DeviceCMYK**, so we can write the canon's *stored* `cmyk` values straight into the PDF rather than letting a converter guess an RGB→CMYK transform. |

Rejected, with reasons:

- **satori** — generates SVG from JSX. Wrong direction; the chassis is already SVG.
- **sharp** — its librsvg path handles text and font fallback poorly, and PDF
  output would be a rasterized page, unusable for apparel or signage.
- **puppeteer / @sparticuz/chromium** — highest fidelity but ~100 MB and slow
  cold starts, and still only produces a rasterized-or-screen PDF.
- **Ghostscript / Inkscape CLI** — not available on Vercel.

Honest limits, stated up front:

1. **Pantone is not exportable as a spot color.** True spot separation needs a
   PDF `Separation` colorspace, which PDFKit does not expose. What we ship is
   DeviceCMYK from the canon's stored values plus a spec sheet naming the
   Pantone — which is what the printer works from anyway. If real spot plates
   are required, that is a prepress hand-off, not a code change.
2. `svg-to-pdfkit` does not cover every SVG feature — filters, some gradient and
   clip-path forms degrade. Mitigation: the template validator (§4) rejects a
   base SVG using unsupported features **at authoring time**, not at render time.
3. Fonts are loaded today via `next/font/google` (Marcellus, Lato, Jost, Noto
   Serif SC — all OFL, embeddable). Server rendering needs the actual files, so
   Phase C uploads them as `font`-kind assets and reads bytes through the admin
   client, never through the HTTP proxy route.

---

## 4. Slot and constraint model

A template's `slots` is an ordered array; each slot declares its type and rules.

```
text      { key, label, fontRole, maxChars, fit: 'shrink'|'wrap'|'reject', minSize }
color     { key, label, roleOrPaletteKey }     -- token reference ONLY, never a literal
asset     { key, label, kind, variant? }       -- filtered; resolves to an asset_id
motif     { key, label }                       -- resolved from the active season
image     { key, label, aspect, minDpi }       -- commissioned artwork
generated { key, label, generator, options }   -- drawn from a value (barcode)
```

Validation runs **before** render and returns human-readable errors:
missing required slot · text overflow at declared size · a color slot given a
literal · seal-red exceeding its 5% ceiling · one-color fallback missing where
the medium requires it. `colorForbidden` and `hardRules` already in the canon
feed this directly.

**Seasons must land with template #1, not after.** Input 9 below resolves
entirely from the active season; a `motif` slot has nothing to resolve against
without `brand_seasons`. This is the one place I'd reorder the brief.

### 4.1 The beer label's slots — owner-specified, 2026-07-30

Nine inputs. Six are typed by hand per release, one is generated, and two
resolve from elsewhere — which is what decides where each one is *edited*.

| # | Slot | Type | Source |
|---|---|---|---|
| 1 | Release name | `text` | `brand_labels.name` — "Drifting Through the Clouds" |
| 2 | Recipe + ABV | `text` | Typed on the label for now. Becomes derived when `brand_labels.recipe_id` lands — "Jasmine Peach Lager, 5.2% ABV" |
| 3 | Container volume | `text` | Per rendition, not per release — "16 fl. oz" |
| 4 | Season / Episode | `text` | Derived from the season + the release's ordinal — "S1 \| E1" |
| 5 | Hero artwork | `image` | A `label_art` asset. The one slot the chassis sizes rather than styles. |
| 6 | Artist name | `text` | Attribution for #5. Belongs with the artwork, not the release. |
| 7 | Flavor text | `text` | Story for the hero artwork. The overflow-prone slot — needs a real `maxChars` and a `fit` rule. |
| 8 | Barcode | `generated` | UPC/EAN. **New slot type** — rendered from a code, not placed as art. See below. |
| 9 | Seasonal motif | `motif` | Resolves to **background color + chop design** from the active season. |

Consequences for the model in §2 and §4:

- **A `generated` slot type is needed** that §4 did not have. A barcode is neither
  text nor a placed asset: it is drawn from a value under a symbology, with
  hard quiet-zone and minimum-magnification rules that a validator must enforce
  or the code will not scan. This is the one slot where a constraint failure is
  invisible on screen and total in the real world.
- **Slot #9 confirms the season model.** A season resolves to exactly two things
  on a label — a background color and a chop glyph — which is why
  `brand_seasons` above carries `background_hex` and `chop_glyph_asset_id` and
  nothing shaped like a "tenant".
- **#5 and #6 travel together.** Artist attribution is a property of the artwork,
  so it belongs on the `label_art` asset row (or its `file_meta`), not re-typed
  per release. Otherwise the same commissioned piece gets credited two ways.
- **#2 is the deferred-FK slot.** Typed by hand today; the moment
  `brand_labels.recipe_id` exists it derives from the recipe and stops being a
  place where the ABV on the can can disagree with the ABV in production.
- **No price slot** — confirmed by the owner; labels never carry one.

---

## 5. Implementation order

Each phase ships something usable on its own.

| # | Phase | Ships | Notes |
|---|---|---|---|
| ✅ **0** | Constraint fix (§0) | `font`/`example` uploads work again | Done — commit `de5fce1` |
| ✅ **A** | Foundations true-up | `chop` + `labelChassis` become editable; `clearspace` + cap-height fields land | Done — commit `db81f67`. Scope grew: see §7. |
| ✅ **B** | Templates + Seasons schema, slot model, validator | Template + Seasons authoring UI; the pre-render validator | Done — commit `6deecc9`. No slot editor yet, deliberately: see §7. |
| **C** | Render pipeline + **Beer label** | PNG + PDF export; full reproducibility record | **Next.** Adds the two deps. Proves slot/constraint/render end to end, incl. the `generated` barcode slot. Blocked — see §8. |
| **D** | **Social** (square / story / landscape) | Multi-format export from one family | Main future consumer of AI drafts. |
| **E** | **Apparel** | Print-ready layouts; **one-color all-indigo fallback** enforced by the validator | First true print-production export. |
| **F** | **Signage** | Slots sized in mm; export at production scale | Feeds the taproom redesign. |
| **G** | **Menu** (print + screen renditions) | Two renditions from one source | **Moved back from D.** Its value is live pricing via `tap_assignments → recipes → recipe_square_links → square_catalog_variations.price_amount` (reusing `CAP.catalogRead`), which needs the deferred `recipe_id` FK. Building a manual price path first would be waste. |
| **H** | **Collateral** | Coasters, cards, flyers, table tents | Stress test that the system generalizes. |
| **I** | AI context endpoint | `GET /api/brand/context` → tokens + rules + active season as JSON | Agent drafts land as `brand_outputs` with `status='draft'`, `source='agent'`. Never skips approval. |

New scopes (added to `lib/auth/scopes.ts` + `capabilities.ts`, both under
section `brand`):

- `brand.templates` — `read` / `manage`. Authoring templates is rare and admin-shaped.
- `brand.outputs` — `read` / `operate` (create a draft render) / `manage` (approve, export).

Nav (`app/brand/nav-config.ts`) gains **Templates**; **Releases** stays and
becomes the per-beer launcher into templates **[locked]**.

---

## 6. Resolved (2026-07-30)

1. **Chassis artwork** — an SVG template exists and will be the base. Structure
   first, file later: §4.1 pins the inputs so the slot model can be built and
   validated before the artwork is wired in.
2. **Wordmark** — settled and fully drawn. `seedCanon`'s "interim placeholder /
   pending" wording is removed. ⚠️ **One conflict surfaced while doing this**:
   `fonts[].wordmark` is **Jost**, but the founder-approved mark spec sheet says
   `Typeface: Marcellus, all caps` for *both* wordmark cuts. One of the two is
   wrong and I did not guess — changing the wordmark font role would alter what
   renders app-wide. See Open Question 1.
3. **CMYK / Pantone** — CMYK derived for every color; **Pantone removed
   entirely** rather than left half-populated. Shipped, see §7.
4. **Chop "tenant"** — term dropped. Modeled as `season.chop_glyph_asset_id`.
5. **Menu pricing** — not needed for labels. `brand_labels.recipe_id` is deferred,
   so **Menu moves from phase D to after Apparel**; building a throwaway manual
   price path ahead of the FK would be waste.

## 7. Progress — paused after Phase B (2026-07-30)

Branch `claude/brand-template-exploration-c43d33`, three commits, working tree
clean. `npm run verify` green: 0 lint errors, typecheck clean, **2670 tests**.
`npm run build` compiles, 105 pages.

### `de5fce1` — Phase 0, the constraint clash

| Change | Files |
|---|---|
| Asset-kind constraint restated as the union of all three lists | `20260907090000_brand_assets_kind_union.sql`, `lib/brand/assets.ts` (+test) |
| Upload dropdown offered 6 kinds while the API accepted 8 | `app/brand/assets/AssetsView.tsx` |

### `db81f67` — CMYK/Pantone + Phase A

| Change | Files |
|---|---|
| CMYK derived for every color; Pantone removed entirely | `20260907100000_…_cmyk_backfill_drop_pms.sql`, `lib/brand/cmyk.ts` (+test), `canon.schema.ts`, `seedCanon.ts`, `SwatchCard.tsx`, `PaletteFacet.tsx`, `markdown.ts` (+test) |
| Palette editor's CMYK is read-only and re-derives from the hex | `PaletteFacet.tsx` |
| `seedCanon` content-muted hex corrected to `#575a66` (was serving a WCAG-failing color on fallback) | `lib/brand/seedCanon.ts` |
| Wordmark "interim placeholder" wording removed | `lib/brand/seedCanon.ts` |
| `chop` / `labelChassis` / `naming` given owners, editors, guide rendering, and blocks in the agent brief | `canonSections.ts`, `ChopFields.tsx`, `ChassisFields.tsx`, `NamingFields.tsx`, `CanonEditor.tsx`, `MarksView.tsx`, `VisualIdentityView.tsx`, `VoiceView.tsx`, `guide/page.tsx`, `markdown.ts` |
| `fonts[].capHeightRatio` + `marks[].clearspaceSpec` | `canon.schema.ts`, `TypeFacet.tsx` |

**Phase A grew beyond its plan line for a reason worth recording:** `chop`,
`labelChassis` and `naming` were owned by no subtab, so they were stored,
editable nowhere, and rendered nowhere — not in the guide and *not in the Agent
Rules brief*. An agent asked to lay out a label got no chassis spec; one asked to
propose a name got the never-words and nothing about the five criteria its
proposal would be judged against. Meanwhile the Releases workbench had been
gating every beer name on `naming.criteria` all along.

### `6deecc9` — Phase B

| Change | Files |
|---|---|
| Slot model — six types incl. `generated` (barcode) | `lib/brand/slots.ts` |
| Pre-render validator, 36 tests | `lib/brand/validateSlots.ts` (+test) |
| `brand_templates` / `brand_seasons` / `brand_outputs` | `20260908090000_brand_templates_seasons_outputs.sql` |
| CRUD modules with archive-before-write ordering | `templates.ts`, `seasons.ts`, `outputs.ts` (+tests), `__fixtures__/fakeBrandClient.ts` |
| Scopes `brand.templates`, `brand.outputs` | `lib/auth/scopes.ts`, `capabilities.ts` (+pinned-coordinate test) |
| API routes | `app/api/brand/{templates,seasons,outputs}/**` |
| Templates + Seasons UI, nav entry | `app/brand/templates/**`, `nav-config.ts` |

### ⚠️ State to be aware of when resuming

1. **Three migrations are unapplied.** `20260907090000` fixes a **live production
   bug** — `font` and `example` uploads currently fail a check violation, and that
   is true whether or not this branch merges. The other two are only needed when
   it lands. Each carries its verification query in a trailing comment.
2. **Nothing has been seen in a browser.** Every surface here was verified by
   build and tests only; the login wall blocked visual checks throughout. That is
   real coverage for logic and none for layout.
3. **Phase B has no slot editor.** Templates can be created, published and
   versioned; their slots are authored through the API. Deliberately deferred to
   Phase C so the editor is designed against a real template rather than guessed
   at.
4. **`naming.criteria` is fixed at five rows.** The schema pins the length and
   `syncNamingCheck` matches saved answers by criterion text, so a sixth row fails
   validation on save and rewording one drops the old answer.

## 8. Open questions

1. ⚠️ **Jost or Marcellus for the wordmark?** `fonts[].wordmark` says Jost;
   the founder-approved mark spec sheet says `Typeface: Marcellus, all caps` for
   both cuts. Since Jost was the entry carrying the "interim placeholder"
   wording, Marcellus is the likely truth — but the wordmark font role is bound
   app-wide, so this is not mine to change unasked.

2. **Panel dimensions and the art-window border.** `labelChassis` specifies every
   element in *relative* terms (4% margins, 8–10% chop height). Two absolutes are
   still missing: the physical panel size per container format, and whether the
   "bordered art window" border is plain geometry or drawn artwork. If it is
   geometry, `base.svg` can be generated rather than imported.

3. **Barcode symbology and source.** UPC-A or EAN-13, and does the number come
   from `square_catalog_variations.upc` (which exists and is populated) or from a
   field on the release? This is the only slot that fails silently — a code that
   renders beautifully and does not scan looks fine until the run is printed.

4. **Container volume — per rendition or per release?** "16 fl. oz" reads like a
   property of the format, which would make it a rendition constant rather than
   a typed input. If a release can ship in two formats, one template with two
   renditions covers it and the slot disappears.

5. **The wordmark asset is uploaded but not wired.** One approved
   `wordmark/horizontal-primary` SVG exists, but `seedCanon`'s mark variants
   carry no `assetIds`, so the guide still renders CSS stand-ins. Attaching it is
   a data action in the Marks editor, not a code change — worth doing before any
   render work treats the guide as truth.

6. **`brand_labels` has 0 rows.** Seed it from the 23 existing recipes, or start
   empty and fill going forward?

7. **Deferred by decision, recorded so it is not lost:**
   `brand_labels.recipe_id uuid references recipes(id) on delete set null`. Until
   it lands, recipe name and ABV are typed by hand onto every label and can
   disagree with production. Revisit once the brand side is stable.
