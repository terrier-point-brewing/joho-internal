# Brand & Design System — Foundation Design

**Date:** 2026-07-19
**Status:** Approved design, pending implementation plan
**Spec scope:** Phase 0 + Phase 1 (concrete buildout). Phases 2–5 documented as roadmap.

## Goal

Stand up a brand system inside the app that (a) holds Joho's brand as a single, versioned, in-app-editable source of truth, (b) exposes it through one stable interface that both internal and future customer-facing surfaces consume, and (c) is designed so the brand identity itself can evolve (rename, recolor, refont) without breaking any consumer. This foundation is what lets marketing / apparel / label / customer-facing features layer on over time.

## Context & key facts

- **Joho is the brewery brand; TPB (Terrier Point Brewing) is the legal entity.** Single brand, built deep. Internal multiplicity is real: Tier 1 canon → per-label Tier 2 palettes → per-motif chop glyphs.
- **Source brand guide:** "Joho Brand Guide v1.0" (2026-07-12, founder-approved, self-described "Placeholder · non-final"). Explicitly authored for *two readers with equal weight: humans who run Joho, and agents that produce its artifacts.* Every section has a Narrative layer (why) + Specification layer (what); "where they conflict, the Specification governs." It already thinks like a machine-consumable spec.
- Brand state = **a mix**: core taking shape (Tier 1 palette, type, voice law, agent rules codified) but most assets not yet created (wordmark is an interim Jost stand-in pending commission; per-label palettes earned over time; chop glyphs added with founder approval).
- **Two design systems coexist by design:**
  - `--color-*` — the internal ops-tool chrome (dark zinc/amber). Product infrastructure: code-owned in `globals.css @theme`, governed by `UI_STANDARD.md`, enforced by the CI no-raw-colors grep. **Out of scope for the brand editor.** Changes on an engineering cadence under code review.
  - `--brand-*` — Joho's identity + rendering. Editable content, DB-backed, founder-governed, evolves. **This is what the brand system owns.**

### Joho canon values (the *current* fill of a brand-agnostic contract)

- **Mission:** "Joho makes authentic, fun cultural exploration accessible to those who want it. Beer is the medium, not the mission."
- **Color — Tier 1 (governs everything Joho owns):** Paper `#f5f0e6` (60%), Indigo `#26355d` (30%), Seal Red `#ad1a2d` (accent, ≤5% of any composition), Camphor Tan `#b3a585` (bridge to the physical room). Each has role + CMYK + PMS. **Tier 2:** each label earns its own palette from its story.
- **Type:** Marcellus (display — beer names/headlines, regular only, title case or small-caps +4%), Lato (body — 400/700, web ≥16px / print ≥8.5pt), Jost (interim wordmark, Medium +2% tracking), Noto Serif SC (CJK/script).
- **Voice:** "A companion, not a teacher. Sincere to the bone… quietly funny, dry." Personality sliders (fixed calibration), a "Never" vocabulary list + "Lean on" list, and a 5-criteria beer-naming system ("Story Title — Plain Style Subtitle").
- **The chop (seal):** a glyph that rotates per motif family; position/footprint/color/rendering never change; founder approval per glyph.
- **Label "chassis":** fixed structure (wordmark band → bordered art window → title slot in Marcellus+Lato); illustration roams, chassis never changes. Poster-style title-in-art lives only in derivative artifacts.
- **Agent quick reference:** top-10 hard rules, explicit precedence chain; "when uncertain: produce nothing; escalate to founder."

## Core principle: consumers bind to roles, never to a brand or color name

Three levels of indirection. The day Joho becomes "Tanka" or Indigo becomes "Cobalt," you edit one row in canon and nothing downstream changes.

1. **Level 1 — Canon (DB, editable):** the actual identity. `Indigo #26355d`, `Marcellus`, ratios, roles. Rename/revalue freely.
2. **Level 2 — Role contract (code, stable):** the vocabulary everything binds to — `--brand-primary`, `--brand-secondary`, `--brand-accent`, `--brand-high-contrast`, `--brand-content`, `--brand-surface`, `--brand-font-display`, `--brand-font-body`… Names never mention the brand or a color. **This is the API.**
3. **Level 3 — Resolved output:** CSS variables (light + dark), the compiled agent brief, and asset URLs — produced by the resolver from Level 1 mapped through Level 2.

## The role contract

### Color roles (`--brand-*`), shown with current Joho fill

| Role token | Purpose | Light fill (Joho now) | Dark fill (derived, on-brand) |
|---|---|---|---|
| `--brand-canvas` | base page bg | Paper `#f5f0e6` | deep indigo `#1a2234` |
| `--brand-surface` | cards/panels | `#efe8da` | `#222c42` |
| `--brand-surface-raised` | raised/pressed | `#ded5c1` | `#2c3750` |
| `--brand-primary` | dominant brand color, primary actions | Indigo `#26355d` | lifted indigo `#4a5c8f` |
| `--brand-on-primary` | text/icon on primary | Paper `#f5f0e6` | Paper `#f5f0e6` |
| `--brand-secondary` | warm bridge neutral | Camphor Tan `#b3a585` | `#b3a585` |
| `--brand-accent` | the ≤5% pop | Seal Red `#ad1a2d` | `#d0455a` |
| `--brand-on-accent` | text on accent | Paper | Paper |
| `--brand-high-contrast` | highest-contrast text | Indigo `#26355d` | Paper `#f5f0e6` |
| `--brand-content` | default body text | `#3a4256` | `#d6cbb4` |
| `--brand-content-muted` | secondary/captions | `#6b6f7d` | `#b3a585` |
| `--brand-line` / `--brand-line-strong` | hairlines/borders | `#ded5c1` / `#b3a585` | `#2c3750` / `#45506d` |

(Fill values above are the starting seed; exact dark values are the derive output and tunable — see below.)

### Type roles (`--brand-font-*`)

`--brand-font-display` (Marcellus), `--brand-font-body` (Lato, 400/700), `--brand-font-wordmark` (Jost, interim), `--brand-font-script` (Noto Serif SC). Swap the family in canon; tokens stay. All four are open-licensed Google fonts, so self-hosting for labels + a public site is unencumbered.

## Light / dark model

- **Dark is derived *from the brand*, not a generic dark theme.** Canon holds `roleMap.light` (explicit) and `roleMap.dark` as **sparse overrides**. The resolver computes `dark[role] = override ?? deriveDark(light[role], role)`, so dark reads as *Joho at night* (deep-indigo canvas, paper text, lifted-indigo primary) — never zinc.
- **Derive-then-override:** dark auto-derives from light by default; the editor pre-fills each dark field with the derived value, and saving persists an override (with a "reset to derived" affordance). Revaluing a light color automatically re-flows dark for any role not hand-tuned.
- The dark override editor is a **facet of the canon editor** (see below), scoped to `--brand-*` only. It never touches the ops chrome `--color-*`.

## Postgres schema (hybrid)

Canon = a **versioned JSONB document** (versioning where it's needed). Catalog = **normalized tables** (relations where they're needed). Mirrors the guide's own Tier 1 / Tier 2 split.

### Canon (versioned document)

```
brand_canon_versions
  id, version_label ("1.0"), status (draft|published|archived),
  document jsonb,          -- the whole canon, structured by stable ref-keys
  changelog text, created_by, created_at, published_at
  -- partial unique index: only one row with status='published'
```

- `document` JSONB is **structured to mirror the guide's section numbers** so it is *easily referenceable*: `canon.color.roles.primary`, `canon.color.roleMap.light`, `canon.color.roleMap.dark`, `canon.voice.neverList`, `canon.naming.criteria`, `canon.precedence`, `canon.chop`, `canon.labelChassis`, `canon.type`.
- A **Zod schema** (`lib/brand/canon.schema.ts`) is the single typed contract — validates every write and generates the TS types consumers import.
- `status` earns its column because *consumers branch on it* (published vs draft). Publishing snapshots an immutable version.
- The `roleMap` (light + dark overrides) lives **inside** the canon document, so a theme tweak is a canon version bump — you can snapshot "what did Joho look like at v1.2," dark tuning included.

### Catalog (normalized, growing)

```
brand_assets   -- foundation columns
  id, kind, variant,                                  -- classification (queried)
  storage_path, format,                               -- file (queried)
  file_meta jsonb,                                    -- w/h/bytes/mime, kind-specific extras
  status,                                             -- lifecycle (draft|approved|archived)
  created_by, created_at, approved_by, approved_at    -- audit
  -- kind ∈ wordmark | chop_glyph | label_art | logo | texture | font | icon | generated_artifact | photo
```

Deferred to the phase that first writes them (not baked in now):
- **`label_id` (FK) + `motif_family`** → added in Phase 3 (labels). Real FK/filter fields; belong as columns then, not jsonb now.
- **`source` (uploaded|ai_generated) + `generator_meta` jsonb** (prompt/model/params provenance) → added in Phase 4 (AI). Nothing writes them until generation exists.

```
brand_labels   -- Phase 3; each beer = a place/era/palette
  id, name (story title), subtitle, description, motif_family, status,
  tier2_palette jsonb,    -- the earned Tier-2 palette, same role shape as canon (EMBEDDED, extractable later)
  naming_check jsonb,     -- the 5 pass-criteria record
  chop_glyph_asset_id?, approved_by, approved_at, created_by, created_at
```

- Generated artifacts are just `brand_assets` with `source='ai_generated'` — no parallel table.
- Approval is inline `status` / `approved_by` columns, gated by `lib/auth.ts` role (canon = admin/founder now; assets/labels = manager+; viewers read), consistent with the RLS rollout.
- **Explicitly dropped:** `is_placeholder` / per-field placeholder flags. The founder is sole canon editor and holds placeholder-vs-final in their head; not worth baking into the schema.

### Storage (Supabase Storage)

- `brand-assets` bucket — binaries (logos, wordmarks, chop glyphs, label art, textures, generated artifacts).
- `brand-fonts` bucket — self-hosted Marcellus/Lato/Jost/Noto (Phase 2; open-licensed).
- RLS follows existing patterns: brand tables admin/service-role write, read via server; a future public surface reads published canon + approved public assets only.

## The resolver — one interface, three outputs

```
lib/brand/
  canon.schema.ts   Zod schema + TS types (the Level-2 contract)
  getCanon.ts       fetch published|preview canon, cached (revalidate tag 'brand-canon' on publish)
  deriveDark.ts     pure light→dark per-role derivation (unit-tested)
  tokens.ts         resolveTokens(canon) → {light, dark, fonts}; emits CSS-variable text
  brief.ts          compileAgentBrief(canon) → precedence-ordered brand spec for AI features
  assets.ts         resolveAsset({kind,variant,motifFamily,labelId}) → approved URL
  BrandStyle.tsx    server component: getCanon → resolveTokens → injects <style> :root + dark
```

- **Output 1 — design tokens** → `--brand-*` CSS variables, injected at runtime from the *published* canon (color edit reflects next request, no redeploy).
- **Output 2 — agent brief** → the guide's Specification layer, compiled and precedence-ordered, injected by every AI feature (voice laws, naming criteria, color ratios, forbidden lists, "produce nothing when uncertain").
- **Output 3 — assets** → `resolveAsset()` returns the right approved binary.

Route handlers in `app/api/brand/**` stay thin over `lib/brand` (business logic in `lib/`), wrapped with `apiError()`. Internal surfaces and a future public site consume the *same* `lib/brand` — extractable to a shared package later with zero contract change, since nothing binds to "Joho" or "indigo."

New/modified `lib/brand/*` modules ship with co-located `*.test.ts` (per repo rule); `deriveDark`, `tokens`, and `brief` are pure and the priority test targets.

## Applying light/dark to the app

Four moving parts, all standard Next patterns:

1. **Define variables once, app-wide.** `<BrandStyle/>` in the root layout injects one `<style>` block defining `--brand-*` for both modes:
   ```css
   :root { --brand-canvas:#f5f0e6; --brand-primary:#26355d; /* light */ }
   :root[data-theme="dark"] { --brand-canvas:#1a2234; --brand-primary:#4a5c8f; /* user forced dark */ }
   @media (prefers-color-scheme: dark) {
     :root:not([data-theme="light"]) { /* system dark unless user forced light */ }
   }
   ```
   Defining `--brand-*` changes nothing on its own — only elements using `var(--brand-*)` react. Ops chrome (`--color-*`) is untouched.
2. **Select the mode.** `data-theme` on `<html>`, **cookie-driven** so the server sets it during SSR (no flash), with `prefers-color-scheme` as the unset fallback. A `<ThemeToggle>` writes the cookie (light / dark / system). The selector precedence above resolves all three cases.
3. **Opt surfaces in — scoped, not global.** Because ops chrome stays dark, brand theming is scoped via a `.brand-surface` wrapper:
   ```css
   .brand-surface { background:var(--brand-canvas); color:var(--brand-content); font-family:var(--brand-font-body); }
   ```
   - **Full-page brand routes** (`/brand/guide`, future public site) wrap the whole viewport → the entire screen is Joho; light/dark flips it all.
   - **Embedded brand previews** inside an ops page are an *island*: the card is `.brand-surface` (Joho light/dark), the dark ops chrome around it stays dark. Intentional.
   - Children use `--brand-*` tokens or **brand component primitives** (`app/components/brand/*`, the brand-scoped parallel to `app/components/ui/*`) — the layer a Phase-5 public site reuses unchanged.
4. **JS that needs the current mode** (e.g. Recharts series on a brand chart) reads it from a `useBrandTheme()` hook over the same cookie/`data-theme` source.

The app doesn't globally "switch to" brand light/dark — brand-scoped surfaces do, driven by one global mode selector, while the ops tool stays dark. Phase 5 (whole internal app wears Joho) is just flipping ops surfaces from `--color-*` to `--brand-*` in code; the machinery is already there.

## In-app surfaces

New top-level `app/brand/` area (peer to `finance/`, `taproom/`, `production/`), following the per-area `nav-config.ts` + `*Nav.tsx` pattern. All role-gated via `lib/auth.ts`; all thin pages over `lib/brand` + `app/api/brand/**`.

- `app/brand/guide/` — **read-only brand guide viewer** rendered from canon in true Joho light/dark. The human-facing "here's who we are" surface (employee alignment). *(Phase 1)*
- `app/brand/canon/` — **multi-facet canon editor** (admin/founder only): facets = **Identity/Content** (mission, voice laws, naming criteria, precedence, chop/label rules), **Palette** (named brand colors), **Theme** (role mapping + light values + dark derive-with-override), **Type** (font role assignments). Draft → publish, version history. Scoped to `--brand-*`; the ops chrome is never editable here. *(Phase 1)*
- `app/brand/assets/` — asset library: upload, approve, filter, resolve. *(Phase 2)*
- `app/brand/labels/` — labels: create, 5-criteria naming check, earn Tier-2 palette, assign chop glyph. *(Phase 3)*
- `app/brand/studio/` — AI generation (marketing/apparel/labels) on the brief + assets, founder-approval gate. *(Phase 4)*

## Phased rollout

Each phase is its own spec → plan → implement cycle (per CLAUDE.md tiering). **This spec covers Phase 0 + 1 as the concrete buildout; 2–5 are the roadmap.**

| Phase | Delivers |
|---|---|
| **0 — Foundation** *(this spec)* | `brand_canon_versions` schema + `brand-assets`/`brand-fonts` buckets + `lib/brand` resolver (`canon.schema`, `getCanon`, `deriveDark`, `tokens`, `brief`, `assets`, `BrandStyle`) + `--brand-*` role contract + brand fonts loaded + cookie-driven light/dark + `.brand-surface` scope + seed canon from Joho v1.0 + one demo brand surface proving light/dark. **The quick win.** |
| **1 — Canon editor + guide viewer** *(this spec)* | in-app multi-facet canon editing, versioning/publish, dark derive-with-override, human-readable guide viewer. Joho→Tanka rename is safe from here. |
| **2 — Asset library** | upload/approve/resolve + self-hosted fonts; wordmark/chop management. Adds no new deferred columns. |
| **3 — Labels + Tier 2** | `brand_labels` table, naming check, per-label palettes (embedded jsonb), chop assignment. Adds `label_id` + `motif_family` to `brand_assets`. |
| **4 — AI studio** | generation (labels/marketing/apparel) on `compileAgentBrief()` + assets, provenance, approval gates. Adds `source` + `generator_meta` to `brand_assets`. AI SDK / Vercel AI Gateway. |
| **5 — Public surface** | extract `lib/brand` tokens + `app/components/brand/*` primitives for a customer-facing site / shared components — zero contract change. |

## Architecture summary

**canon → role contract → resolver → three outputs (tokens / agent brief / assets) → internal now, public later.**

## Decisions locked

- Joho = brand, TPB = legal entity. Single brand, deep.
- Storage: Supabase-backed, in-app editable, versioning + approval as first-class schema; founder-only canon editing now, staff later via role check.
- Naming: semantic role contract (`--brand-primary`, `--brand-high-contrast`, `--brand-font-display`…), never brand/color names.
- Dark auto-derives from light first, editable after (sparse overrides in canon).
- Schema shape: hybrid (canon jsonb document + normalized catalog). Lean `brand_assets`; phase-specific columns added per phase. No `is_placeholder`.
- `brand_labels.tier2_palette` embedded jsonb, extractable later.
- Two design systems stay separate: brand editor governs `--brand-*` only; ops chrome `--color-*` stays code-owned.
- Spec scope: Phase 0 + 1 concrete; 2–5 roadmap.

## Open items for the implementation plan

- Exact `deriveDark()` per-role rules (lightness/chroma shifts, contrast floors) — needs a concrete algorithm + tests.
- Canon Zod schema field-by-field (full section coverage).
- Cookie name / SSR wiring for `data-theme`; brand font loading via `next/font` (Phase 0) vs self-host (Phase 2).
- Seed migration content: translate the Joho v1.0 guide into the canon document shape.
