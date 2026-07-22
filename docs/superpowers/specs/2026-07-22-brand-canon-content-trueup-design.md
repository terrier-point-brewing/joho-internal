# Brand Canon — Content True-up + Ethos Expansion Design

**Date:** 2026-07-22
**Status:** Approved design, building inline
**Builds on:** Phases 0–3 (merged). This is a content + schema correction, not a new feature phase.

## Problem

The Phase 0 seed canon **fabricated** several fields (a subagent invented plausible brand content) and **omitted** the entire Narrative/ethos layer. The live in-app guide misrepresents Joho: it shows an invented "companion at the end of the day" mission instead of the real "cultural exploration; beer is the medium," invented lean-words, invented beer names, and our CSS-token rules mislabeled as the brand's rules. The original founder-approved v1.0 guide (fully extracted) is the source of truth.

## Goals

1. **Correct** the fabricated fields to the real founder-approved content.
2. **Add** the missing permanent sections (values+costs, Never List, voice rewrites, forbidden colors, the chop, label chassis, illustration law, the 10 hard rules, mission narrative).
3. Do it **durably**: every added field is a typed, named, permanent part of the canon — editable over time via the existing Content (JSON) facet, rendered in the guide, and consumed by the agent brief. No throwaway sections.
4. Support the eventual **public site (Phase 5)** without leaking internal strategy: a per-section `visibility` tag.

Non-goal: the "non-final" placeholder framing — the canon is built to evolve, so this is simply the best current version; no special placeholder handling.

## Canon schema — the durable shape (extends `canon.types.ts` / `canon.schema.ts`)

Added/changed typed fields (each a permanent slot):

```ts
type Visibility = "internal" | "public";
type SectionKey =
  | "mission" | "values" | "neverList" | "voice" | "naming"
  | "color" | "typography" | "chop" | "labelChassis"
  | "illustrationLaw" | "hardRules" | "precedence";

interface CoreValue { n: string; title: string; means: string; cost: string }
interface VoiceSlider { left: string; right: string; pos: number; note: string }  // pos 0–100
interface VoiceRewrite { context: string; on: string; off: string }
interface NamingExample { name: string; why: string }
interface KeyVal { key: string; value: string }
interface ChassisElement { n: string; title: string; desc: string }

interface BrandCanon {
  brandName; version;
  mission: string;               // canonical one-liner
  missionNarrative: string;      // NEW — the "why"
  values: CoreValue[];           // NEW §01
  neverList: string[];           // NEW
  voice: {
    summary; personality;        // personality NEW (narrative)
    sliders: VoiceSlider[];      // now calibrated (pos + note)
    neverWords; leanOnWords;
    rewrites: VoiceRewrite[];    // NEW do/don't
  };
  naming: { pattern; narrative /*NEW*/; criteria; passingExamples };
  palette: BrandColor[];         // populate cmyk/pms (already optional)
  roleMap; usageRatios;
  colorForbidden: string[];      // NEW
  fonts: BrandFont[];            // usage rules enriched in note
  chop: { narrative; specs: KeyVal[] };            // NEW
  labelChassis: { narrative; elements: ChassisElement[] };  // NEW
  illustrationLaw: { narrative; rules: string[] }; // NEW
  hardRules: string[];           // RENAME of agentRules → the 10 real brand rules
  precedence: string[];
  visibility: Record<SectionKey, Visibility>;      // NEW — Phase 5 public filter
}
```

- `agentRules` → **`hardRules`** (it never held brand rules — it held our CSS-token dev rules, which belong in code/docs, not the brand canon). Update `compileAgentBrief`, `ContentFacet`, guide, tests.
- **Editing:** all new text sections join `ContentFacet`'s `CONTENT_KEYS` — edited as validated JSON, no new bespoke facets (per the Phase 1 decision). Palette/Theme/Type facets unchanged.
- **Rendering:** the guide viewer gains sections for values, Never List, voice rewrites, forbidden colors, the chop, chassis, illustration law, hard rules, mission narrative — all shown in the internal (auth-gated) guide.
- **`visibility`:** defaults — public: mission/naming/color/typography; internal: values/neverList/voice/chop/labelChassis/illustrationLaw/hardRules/precedence. The internal guide shows everything; a Phase 5 public renderer filters to `public`. (Field-level nuance like "values.means public, values.cost internal" is left to Phase 5.)

## Content source

`seedCanon.ts` is rewritten verbatim from the extracted founder-approved v1.0 data (values, costs, 6 nevers, 6 calibrated sliders, real never/lean words, 3 rewrites, real naming criteria + 4 examples, 4 colors with role/cmyk/pms, 4 forbidden rules, 5 chop specs, 4 chassis elements, 6 illustration rules, 10 hard rules, mission + narrative).

## DB true-up

The live app reads the **published** `brand_canon_versions` row (seeded with the old fabricated content by migration `20260808`), so `seedCanon` alone won't fix production. Migration `20260813_brand_canon_content_trueup.sql` (human-gated) `UPDATE`s the published row's `document` to the corrected canon and bumps `version_label` to `1.1` (changelog: "content true-up + ethos expansion"). The JSON is generated from the finalized `seedCanon` and verified to deep-equal it (drift guard). Until applied, the app still shows old content in prod, but the code/fallback is correct.

## Testing

- `canon.schema` parses the new `seedCanon`; a missing new section fails validation.
- `compileAgentBrief` includes values, nevers, voice rewrites, illustration law, hard rules (richer brief for Phase 4).
- Guide renders defensively (a section omitted if its data is empty) so a stale DB row (pre-migration) never crashes the page.
- `resolveTokens`/`deriveDark` untouched (palette/roleMap shape unchanged).

## Decisions locked

- Correct fabrications + add the full ethos layer, all as typed permanent fields.
- `agentRules` → `hardRules` (real 10 brand rules).
- New text sections editable via the existing Content JSON facet.
- Per-section `visibility` for Phase 5.
- DB true-up migration bumps published canon to 1.1 (human-gated), generated from seedCanon.
