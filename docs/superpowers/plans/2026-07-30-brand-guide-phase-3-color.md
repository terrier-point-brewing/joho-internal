# Brand Guide Phase 3 — Color Implementation Plan

> Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Rebuild the Color subtab so palette and theme are visibly linked, every print code is copyable, and dark mode binds to real palette colors instead of being computed at render time.

**Execution Budget:** inline execution (no subagents this session) · token target ≈ 150k.

**Architecture:** Dark mode stops being derived at runtime and becomes a mapping like light. `deriveDarkPalette` is demoted from resolver to editor-time suggestion engine, behind an explicit button that snaps to the nearest palette color in OKLab and offers to add one where nothing is close. The render path keeps a fallback so the code is safe before the migration lands.

## Global Constraints

Same as phases 1–2: brand tokens under `app/brand/guide/**`, app tokens for editor chrome, no hand-rolled primitives, React Compiler rules are lint errors, `npm run verify` is the definition of done, migrations human-gated.

⚠️ **No browser verification** (login wall). ⚠️ **Verify token changes by computed style, not a green build** — this repo has shipped dead token classes that passed both `verify` and the no-raw-colors grep.

---

## Settled decisions (from the proposal, §3.4-B)

**5 new palette colors.** Dark mode inverts Indigo and Paper rather than adding a parallel neutral ramp; seven of thirteen dark roles bind to colors the brand already owns.

| Key | Hex | Name | Dark roles |
|---|---|---|---|
| `midnight` | `#131b2f` | Midnight | canvas · on-accent |
| `indigo-2` | `#364672` | Indigo 2 | surface-raised · line |
| `indigo-3` | `#4b5c8b` | Indigo 3 | line-strong |
| `chalk` | `#afb7ca` | Chalk | content-muted |
| `vermilion` | `#f37149` | Vermilion | accent |

**Existing colors:** `content-muted` hex `#6b6f7d` → **`#575a66`** (it fails AA on all three light grounds today). Four names drop the misleading `(derived)` suffix. Indigo, Paper, Seal Red and Camphor Tan are untouched.

**Complete `roleMap.dark`** — every role bound to a palette key, zero detached hexes:
```
canvas→midnight  surface→indigo  surface-raised→indigo-2  line→indigo-2
line-strong→indigo-3  primary→paper  on-primary→indigo  high-contrast→paper
content→paper-2  content-muted→chalk  accent→vermilion  on-accent→midnight
secondary→camphor
```

**Accent is held to AA-large on the two lighter dark grounds**, deliberately — the canon already forbids Seal Red as body text under 18px and caps it at 5% of a composition, so 3:1 is the correct target for a color that is never small body text.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/brand/colorDistance.ts` *(new)* | hex→OKLab, ΔE, nearest palette match. Pure. |
| `lib/brand/paletteLinks.ts` *(new)* | role↔palette-key indexes. Pure. Promoted out of PaletteFacet. |
| `lib/brand/suggestDark.ts` *(new)* | derive → snap → add, with the collision guard. Pure. |
| `lib/brand/canon.schema.ts` *(modify)* | `tier` on `brandColorSchema`. |
| `lib/brand/tokens.ts` *(modify)* | `resolveDark` mirrors `resolveLight`, with a derivation fallback. |
| `app/brand/guide/blocks/SwatchCard.tsx` *(new)* | Swatch + use case + every code copyable + "Drives:". |
| `app/brand/guide/blocks/RatioBar.tsx` *(new)* | 60/30/10 proportion bar. |
| `app/brand/guide/ColorView.tsx` *(modify)* | Palette by tier → Theme table → ratios → Forbidden. |
| `app/brand/canon/facets/PaletteFacet.tsx` *(modify)* | tier + all codes. |
| `app/brand/canon/facets/ThemeFacet.tsx` *(modify)* | dark binds to palette keys; auto-derive button. |
| `supabase/migrations/20260905_brand_canon_color_expansion.sql` *(new)* | Palette expansion, renames, hex fix, complete `roleMap.dark`. |

---

### Task 1 — `colorDistance` (pure)

```ts
export function hexToOklab(hex: string): [number, number, number];
export function deltaE(a: string, b: string): number;                    // OKLab euclidean
export function nearestKey(hex: string, palette: {key: string; hex: string}[]):
  { key: string; distance: number } | null;
```
OKLab, not RGB euclidean: RGB distance happily calls warm Camphor Tan "close to" a cool blue-grey, which is exactly the wrong answer for the marginal content roles.

Tests: identical colors → ΔE 0; Seal Red vs Vermilion > 0.1; nearest picks the closest key; empty palette → null; ΔE is symmetric.

### Task 2 — `paletteLinks` (pure)

```ts
export function rolesByPaletteKey(roleMap, mode): Map<string, RoleName[]>;
export function isPaletteKey(value: string, palette): boolean;
```
Promoted out of `PaletteFacet`'s inline loop so the **view and the editor share one implementation** — the bidirectional highlight depends on both sides agreeing.

Tests: a key driving two roles lists both; a raw hex is not a palette key; an unbound key maps to `[]`.

### Task 3 — `suggestDark` (pure)

```ts
export interface DarkSuggestion {
  role: RoleName; derived: string; nearestKey: string | null;
  distance: number; verdict: "snap" | "add";
}
export function suggestDarkRoles(canon): DarkSuggestion[];
```
`verdict` is `snap` below ΔE 0.06, else `add`.

**Collision guard:** roles in a known-distinct pair may not snap to the same key — `canvas`/`surface`, `surface`/`surface-raised`, `surface-raised`/`line-strong`. The second one escalates to `add`. Note `surface-raised`/`line` is deliberately NOT such a pair: they share a key in both modes by design, as Paper 3 already does in light.

Tests: a role with an exact palette match snaps; a role with nothing close adds; two distinct-pair roles never snap to one key; output covers all 13 roles.

### Task 4 — Schema + token resolution

`brandColorSchema` gains `tier: z.enum(["core","neutral"]).optional()`.

`resolveDark(canon)` mirrors `resolveLight`: resolve each role's `roleMap.dark` value as a palette key or raw hex. **Fall back to `deriveDarkPalette` for any role the map omits** — without that, deploying before migration 20260905 leaves dark mode entirely unresolved. The fallback is the safety net that lets the migration land whenever.

Tests: a complete dark map resolves entirely from the palette; a partial map falls back per-missing-role; an empty map matches today's derived output exactly (proving no visual change before the migration).

### Task 5 — View

Palette grouped by tier (Core / Neutrals) as `SwatchCard`s: swatch, name, use case in body text, `HEX`/`RGB`/`CMYK`/`PMS` chips each independently copyable, a mono `key` chip, and `Drives: canvas, line`.

Theme as a role table showing light and dark side by side with their **source** (`← Paper`), flagging `detached` and `derived`. Ratios as a `RatioBar`. Forbidden grid unchanged from phase 2.

### Task 6 — Editors + migration

`PaletteFacet`: tier select, all four code inputs. `ThemeFacet`: dark column becomes a palette-key select mirroring light, plus an **Auto-derive dark mode** button that shows each suggestion with its ΔE and verdict and applies on confirm.

Migration `20260905`: add the 5 colors, rename 4, fix `content-muted`, write the complete `roleMap.dark`, set `tier` on every entry. Idempotent — skip colors whose key already exists.

**Acceptance:** dark mode renders identically before and after the migration (fallback), and entirely from the palette after it.
