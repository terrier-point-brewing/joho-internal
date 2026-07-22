# Brand & Design System — Phase 0 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the brand-token foundation — a versioned canon in Postgres, a pure resolver (`lib/brand`) that emits design tokens / agent brief / assets, runtime-injected `--color-brand-*` CSS variables with brand-derived light/dark, and a demo brand surface proving it end-to-end.

**Architecture:** Canon lives as a versioned JSONB document (`brand_canon_versions`); a single typed seed constant (`seedCanon.ts`) is the source of truth mirrored into the seed migration and used as `getCanon()`'s fallback. Pure functions resolve the canon into light+dark token palettes (dark auto-derived from light, brand-hued) and a compiled agent brief. `<BrandStyle>` injects the tokens at runtime in the root layout; brand surfaces opt in via a `.brand-surface` scope. The internal ops chrome (`--color-*`) is untouched.

**Tech Stack:** Next.js 16 (App Router, Server Components), React 19, Tailwind v4 (`@theme`), Supabase Postgres, `next/font/google`, Vitest.

## Global Constraints

- Consumers bind to **semantic role tokens only** (`--color-brand-primary`, `text-brand-high-contrast`, `font-brand-display`) — never a brand or color name. "Joho"/"Indigo"/"Marcellus" appear ONLY inside canon data.
- Two design systems stay separate: this work touches `--color-brand-*` only; **never modify the existing `--color-*` ops tokens** in `app/globals.css @theme` (lines 9–54) or the ops chrome. No raw colors in feature code (`docs/UI_STANDARD.md`).
- Dark mode auto-derives from light; canon `roleMap.dark` holds **sparse overrides** applied over the derived values.
- New/modified `lib/**` modules ship co-located `*.test.ts`; **do not drop `lib/**` coverage below 86% lines/statements** (`vitest.config.ts`). `deriveDarkPalette`, `resolveTokens`, `compileAgentBrief`, and the theme helper are the pure test targets.
- Next.js 16: `cookies()` is **async** (`await cookies()`); `revalidateTag(tag, profile)` takes a cacheLife arg. `@/` path alias → repo root.
- Supabase: read via `createSupabaseServerClient()` (`lib/supabase/server.ts`). Migration is **human-gated** — do NOT auto-apply; end its header with "Human-gated (do not auto-apply)."
- Zod is **not** a dependency and is **not** added in Phase 0 — the canon contract is TS types now; runtime write-validation (zod) arrives in Phase 1 with the editor.
- Verify command: `npm run verify` (lint + typecheck + tests) is the per-task DoD.

## File Structure

| File | Responsibility |
|---|---|
| `lib/brand/canon.types.ts` | TS types for the canon document + the `RoleName` / `FontRole` unions (the Level-2 contract). |
| `lib/brand/seedCanon.ts` | Joho v1.0 canon as a typed constant — single source for the migration seed + `getCanon()` fallback. |
| `lib/brand/deriveDark.ts` | Pure `deriveDarkPalette(light)` — brand-hued light→dark derivation. |
| `lib/brand/tokens.ts` | Pure `resolveTokens(canon)` → `{light,dark,fonts}` + `emitBrandCss(tokens)`. |
| `lib/brand/brief.ts` | Pure `compileAgentBrief(canon)` → precedence-ordered brand spec string. |
| `lib/brand/getCanon.ts` | Server: fetch published canon (cached), fall back to `seedCanon`. |
| `lib/brand/theme.ts` | Pure theme-cookie helpers (`THEME_COOKIE`, `resolveThemeAttr`). |
| `supabase/migrations/20260808_brand_canon_versions.sql` | `brand_canon_versions` table + RLS + seed Joho v1.0 row. |
| `app/globals.css` | Add `@theme` brand token + font seeds (light) and `.brand-surface` scope. **Append only.** |
| `app/components/brand/BrandStyle.tsx` | Server component: `getCanon → resolveTokens → emitBrandCss`, injected `<style>`. |
| `app/components/brand/ThemeToggle.tsx` | Client: light/dark/system toggle; writes cookie + `data-theme`. |
| `app/components/brand/useBrandTheme.ts` | Client hook: current resolved mode for JS consumers. |
| `app/layout.tsx` | Wire brand fonts, `data-theme` from cookie, `<BrandStyle/>`. **Modify.** |
| `app/brand/preview/page.tsx` | Demo brand surface (swatches + type) in light/dark. |

## Execution Budget

- **Mode:** subagent-driven-development (multi-group). Group by file locality: **G1** `lib/brand/*` (Tasks 1–4, 6, 8 pure/lib), **G2** SQL (Task 5), **G3** `app/` styling + injection + layout (Tasks 7, 9, 10), **G4** demo (Task 11). Route lib tasks to ONE agent sequentially; same for the `app/` styling group.
- **Spawn cap = 6** (4 locality groups + 2). Executor STOPS and reports before exceeding. Override via `CLAUDE_SPAWN_CAP`.
- **Token target:** ~250k. Route implementation/mechanical tasks to the lean `impl` agent type; honor the per-task `model`.

## Task / Model table

| Task | Deliverable | Model |
|---|---|---|
| 1 | Canon types + seed constant | Sonnet |
| 2 | `deriveDarkPalette` (TDD) | Sonnet |
| 3 | `resolveTokens` + `emitBrandCss` (TDD) | Sonnet |
| 4 | `compileAgentBrief` (TDD) | Sonnet |
| 5 | Seed migration (table + RLS + data) | Sonnet |
| 6 | `getCanon` + fallback (TDD, mocked) | Sonnet |
| 7 | globals.css brand `@theme` + `.brand-surface` | Sonnet |
| 8 | `theme.ts` cookie helper (TDD) | Sonnet |
| 9 | `BrandStyle` + fonts + `data-theme` in layout | Sonnet |
| 10 | `ThemeToggle` + `useBrandTheme` | Sonnet |
| 11 | Demo brand surface `/brand/preview` | Haiku |

---

## Canon document shape (authoritative contract — Task 1 encodes this)

```ts
// lib/brand/canon.types.ts
export type RoleName =
  | "canvas" | "surface" | "surface-raised"
  | "primary" | "on-primary" | "secondary"
  | "accent" | "on-accent"
  | "high-contrast" | "content" | "content-muted"
  | "line" | "line-strong";
export type FontRole = "display" | "body" | "wordmark" | "script";

export interface BrandColor { key: string; name: string; hex: string; cmyk?: string; pms?: string; }
export interface BrandFont  { role: FontRole; family: string; cssStack: string; weights: number[]; note?: string; }

export interface RoleMap {
  // each role → a brand color `key` (from palette) OR a raw hex
  light: Record<RoleName, string>;
  // sparse overrides applied over the derived dark palette (role → hex)
  dark: Partial<Record<RoleName, string>>;
}

export interface BrandCanon {
  brandName: string;            // "Joho"  (data only — never referenced by token names)
  version: string;             // "1.0"
  mission: string;
  palette: BrandColor[];        // Paper / Indigo / Seal Red / Camphor Tan (+ neutrals)
  roleMap: RoleMap;
  usageRatios: { role: RoleName; pct: number; note?: string }[]; // Paper 60 / Indigo 30 / accent 10
  fonts: BrandFont[];
  voice: { summary: string; sliders: { label: string; left: string; right: string; note: string }[];
           neverWords: string[]; leanOnWords: string[] };
  naming: { pattern: string; criteria: string[]; passingExamples?: { name: string; why: string }[] };
  precedence: string[];         // ordered precedence chain (§10)
  agentRules: string[];         // the top-10 hard rules (§8)
}

export interface ResolvedTokens {
  light: Record<RoleName, string>;   // role → hex
  dark:  Record<RoleName, string>;   // role → hex (derived ?? override)
  fonts: Record<FontRole, string>;   // role → cssStack
}
```

`resolveTokens` resolves each `roleMap.light[role]` that is a palette `key` to its hex (raw hex passes through). `roleMap.dark` overrides win over derivation.

---

### Task 1: Canon types + seed constant

**Files:**
- Create: `lib/brand/canon.types.ts`
- Create: `lib/brand/seedCanon.ts`
- Test: `lib/brand/seedCanon.test.ts`

**Interfaces:**
- Produces: all types above; `export const seedCanon: BrandCanon`.

- [ ] **Step 1: Write the failing test** — `seedCanon.test.ts` asserts the seed is internally complete (the checks every later consumer relies on):
  - every `RoleName` has an entry in `seedCanon.roleMap.light`;
  - every `roleMap.light` value is either a `palette[].key` or a `#hex`;
  - every `FontRole` has exactly one `fonts[]` entry;
  - `mission`, `voice.summary` non-empty; `agentRules.length >= 1`; `naming.criteria.length === 5`.
- [ ] **Step 2: Run** `npx vitest run lib/brand/seedCanon.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Write `canon.types.ts`** (the contract above) and `seedCanon.ts` encoding **Joho v1.0** from the spec:
  - palette: `paper #f5f0e6`, `indigo #26355d`, `seal-red #ad1a2d`, `camphor #b3a585`, plus neutrals `paper-2 #efe8da`, `paper-3 #ded5c1`, `content #3a4256`, `content-muted #6b6f7d`;
  - `roleMap.light`: canvas→paper, surface→paper-2, surface-raised→paper-3, primary→indigo, on-primary→paper, secondary→camphor, accent→seal-red, on-accent→paper, high-contrast→indigo, content→content, content-muted→content-muted, line→paper-3, line-strong→camphor; `roleMap.dark: {}`;
  - `usageRatios`: canvas 60, primary 30, accent 10 (note "Seal Red ≤5% of any composition");
  - fonts: display=Marcellus (`"Marcellus", serif`, [400]), body=Lato (`"Lato", sans-serif`, [400,700]), wordmark=Jost (`"Jost", sans-serif`, [500], note "interim placeholder — pending §11"), script=Noto Serif SC (`"Noto Serif SC", serif`, [400]);
  - voice summary "A companion, not a teacher. Sincere to the bone… quietly funny, dry."; `neverWords`/`leanOnWords` seeded from the guide (may be short lists — expand in Phase 1); naming.pattern "Story Title — Plain Style Subtitle" with the 5 criteria verbatim from the spec;
  - `precedence`: ["Specification over Narrative", "Full sections over the agent quick-reference (§8)", "When uncertain: produce nothing; escalate to founder"];
  - `agentRules`: the hard rules from the spec's Agent quick-reference summary.
- [ ] **Step 4: Run** the test — Expected: PASS.
- [ ] **Step 5: Commit** `feat(brand): canon types + Joho v1.0 seed constant`.

---

### Task 2: `deriveDarkPalette` (brand-hued light→dark)

**Files:**
- Create: `lib/brand/deriveDark.ts`
- Test: `lib/brand/deriveDark.test.ts`

**Interfaces:**
- Consumes: `RoleName`, resolved light hexes.
- Produces: `export function deriveDarkPalette(light: Record<RoleName,string>): Record<RoleName,string>`.

**Non-obvious logic** — dark backgrounds borrow the **primary hue** (so dark reads as "Joho at night", not brown-from-Paper); content roles become light; primary/accent lift. Per-role treatment map + HSL transform:

```ts
// treatment per role
const T: Record<RoleName, {k:"bgDark"|"contentLight"|"lift"|"brighten"|"keep", L?:number, S?:number}> = {
  canvas:{k:"bgDark",L:12}, surface:{k:"bgDark",L:16}, "surface-raised":{k:"bgDark",L:21},
  line:{k:"bgDark",L:26}, "line-strong":{k:"bgDark",L:34},
  "high-contrast":{k:"contentLight",L:92}, content:{k:"contentLight",L:80}, "content-muted":{k:"contentLight",L:66},
  primary:{k:"lift",L:60}, accent:{k:"brighten",L:60},
  secondary:{k:"keep"}, "on-primary":{k:"keep"}, "on-accent":{k:"keep"},
};
// bgDark → hsl(primaryHue, ~28%, L); contentLight → hsl(contentHue||40, ~25%, L);
// lift/brighten → hsl(ownHue, ownS, L); keep → light value unchanged.
```

Implement `hexToHsl`/`hslToHex` helpers in-file (pure). `primaryHue = hue(light.primary)`, `contentHue = hue(light["high-contrast"])`.

- [ ] **Step 1: Write failing test** asserting on `deriveDarkPalette(resolveLight(seedCanon))` (compute light hexes inline from seed):
  - `canvas` dark lightness < 20% AND its hue within ±12° of `primary` light hue;
  - `high-contrast` dark lightness > 85%;
  - `primary` dark lightness between 50–70% (legible on dark);
  - `on-primary` dark **equals** its light value (`keep`);
  - result has all 13 `RoleName` keys, each a valid `#rrggbb`.
- [ ] **Step 2: Run** `npx vitest run lib/brand/deriveDark.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `deriveDark.ts` per the treatment map + HSL helpers.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(brand): brand-hued dark palette derivation`.

---

### Task 3: `resolveTokens` + `emitBrandCss`

**Files:**
- Create: `lib/brand/tokens.ts`
- Test: `lib/brand/tokens.test.ts`

**Interfaces:**
- Consumes: `BrandCanon`, `deriveDarkPalette`.
- Produces:
  - `export function resolveTokens(canon: BrandCanon): ResolvedTokens`
  - `export function emitBrandCss(t: ResolvedTokens): string`

`resolveTokens`: build `light` by resolving each `roleMap.light[role]` (palette key → hex, or raw hex); `dark = { ...deriveDarkPalette(light), ...canon.roleMap.dark }`; `fonts[role] = fonts.find(role).cssStack`.

`emitBrandCss` returns CSS text (no `<style>` tag) with exactly:
```
:root{ --color-brand-<role>:<lightHex>; … --font-brand-<fontRole>:<stack>; }
:root[data-theme="dark"]{ --color-brand-<role>:<darkHex>; … }
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){ --color-brand-<role>:<darkHex>; … }}
```

- [ ] **Step 1: Write failing test:**
  - `resolveTokens(seedCanon).light.primary === "#26355d"` (indigo key resolved);
  - `.dark.primary` differs from light and is a valid hex;
  - `.dark["on-primary"] === .light["on-primary"]`;
  - a `roleMap.dark` override (construct a canon variant with `dark:{primary:"#123456"}`) makes `.dark.primary === "#123456"`;
  - `.fonts.display === '"Marcellus", serif'`;
  - `emitBrandCss(resolveTokens(seedCanon))` contains `--color-brand-canvas:#f5f0e6`, a `[data-theme="dark"]` block, and `@media (prefers-color-scheme:dark)`.
- [ ] **Step 2: Run** `npx vitest run lib/brand/tokens.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `tokens.ts`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(brand): resolveTokens + emitBrandCss`.

---

### Task 4: `compileAgentBrief`

**Files:**
- Create: `lib/brand/brief.ts`
- Test: `lib/brand/brief.test.ts`

**Interfaces:**
- Produces: `export function compileAgentBrief(canon: BrandCanon): string`.

Emits a deterministic, precedence-ordered plain-text brief for AI features: mission → voice summary + never/lean-on lists → color roles with usage ratios (and the "Seal Red ≤5%" rule) → naming pattern + 5 criteria → precedence chain → agent hard rules. Ends with the standing rule "When uncertain: produce nothing; escalate to founder."

- [ ] **Step 1: Write failing test:** `compileAgentBrief(seedCanon)` includes the mission text, all 5 naming criteria, every `neverWords` entry, the string "≤5%", and ends with "escalate to founder"; and is stable (calling twice returns identical output).
- [ ] **Step 2: Run** `npx vitest run lib/brand/brief.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `brief.ts`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(brand): compileAgentBrief`.

---

### Task 5: Seed migration — `brand_canon_versions`

**Files:**
- Create: `supabase/migrations/20260808_brand_canon_versions.sql` (use next unused number if 20260807 is taken).

DDL + RLS + seed. RLS: enable; allow **anon SELECT of published rows only** (brand colors are non-sensitive and a future public site reads them); writes are service-role only (no anon/auth write policy). Seed one row `version_label='1.0'`, `status='published'`, `document` = the JSON form of `seedCanon` (Task 1).

```sql
-- Brand canon — versioned brand identity document (Joho v1.0).
-- Single published row governs --color-brand-* tokens + the agent brief.
-- Mirrors lib/brand/seedCanon.ts (keep in sync). Human-gated (do not auto-apply).
create table if not exists public.brand_canon_versions (
  id uuid primary key default gen_random_uuid(),
  version_label text not null,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  document jsonb not null,
  changelog text,
  created_by uuid,
  created_at timestamptz not null default now(),
  published_at timestamptz
);
-- at most one published row
create unique index if not exists brand_canon_one_published
  on public.brand_canon_versions ((status)) where status = 'published';
alter table public.brand_canon_versions enable row level security;
drop policy if exists brand_canon_read_published on public.brand_canon_versions;
create policy brand_canon_read_published on public.brand_canon_versions
  for select using (status = 'published');
insert into public.brand_canon_versions (version_label, status, document, published_at)
values ('1.0','published', '{ …seedCanon JSON… }'::jsonb, now());
```

- [ ] **Step 1:** Write the migration; paste the exact JSON serialization of `seedCanon` into the `insert`.
- [ ] **Step 2:** Validate the JSON parses: `node -e "JSON.parse(require('fs').readFileSync('…/20260808_brand_canon_versions.sql','utf8').match(/'({[\\s\\S]*})'::jsonb/)[1])"` — Expected: no error.
- [ ] **Step 3:** Confirm header ends with "Human-gated (do not auto-apply)." Do **not** apply to prod.
- [ ] **Step 4: Commit** `feat(brand): brand_canon_versions table + Joho v1.0 seed migration`.

---

### Task 6: `getCanon` (server read + fallback)

**Files:**
- Create: `lib/brand/getCanon.ts`
- Test: `lib/brand/getCanon.test.ts`

**Interfaces:**
- Produces: `export async function getCanon(): Promise<BrandCanon>` — returns the published `document` (typed) or `seedCanon` if none/empty/error.

Wrap the body in `cacheTag`/`revalidateTag('brand-canon', 'max')`-ready structure (Phase 1 invalidates on publish); Phase 0 may fetch per request. Use `createSupabaseServerClient()`; select `document` where `status='published'` limit 1.

- [ ] **Step 1: Write failing test** injecting a fake fetcher (extract the query into `getCanonFrom(client)` for testability): (a) client returns a row → its `document`; (b) client returns empty → `seedCanon`; (c) client throws → `seedCanon`.
- [ ] **Step 2: Run** `npx vitest run lib/brand/getCanon.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `getCanon.ts` with `getCanonFrom(client)` (pure-ish, tested) and `getCanon()` wiring the real server client.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(brand): getCanon with seed fallback`.

---

### Task 7: Brand `@theme` tokens + `.brand-surface` (globals.css)

**Files:**
- Modify: `app/globals.css` (**append after line 54 inside `@theme`, and add `.brand-surface` in the components layer** — never touch the existing `--color-*` block).

Add brand token **seeds** so Tailwind generates `bg-brand-*` / `text-brand-*` / `border-brand-*` utilities and there's a light fallback before `<BrandStyle>` runs. Values = Joho light (BrandStyle overrides the same custom props at runtime, incl. dark). Add font tokens too.

```css
@theme {
  /* … existing ops --color-* untouched … */
  /* Brand tokens (runtime-overridden by BrandStyle; these are light seeds) */
  --color-brand-canvas:#f5f0e6; --color-brand-surface:#efe8da; --color-brand-surface-raised:#ded5c1;
  --color-brand-primary:#26355d; --color-brand-on-primary:#f5f0e6; --color-brand-secondary:#b3a585;
  --color-brand-accent:#ad1a2d; --color-brand-on-accent:#f5f0e6;
  --color-brand-high-contrast:#26355d; --color-brand-content:#3a4256; --color-brand-content-muted:#6b6f7d;
  --color-brand-line:#ded5c1; --color-brand-line-strong:#b3a585;
  --font-brand-display:"Marcellus",serif; --font-brand-body:"Lato",sans-serif;
  --font-brand-wordmark:"Jost",sans-serif; --font-brand-script:"Noto Serif SC",serif;
}
@layer components {
  .brand-surface{ background:var(--color-brand-canvas); color:var(--color-brand-content);
    font-family:var(--font-brand-body); }
}
```

- [ ] **Step 1:** Append the brand tokens + `.brand-surface` (do not modify existing lines 9–54).
- [ ] **Step 2:** `npm run build` — Expected: succeeds; `bg-brand-primary` is a valid utility (verified visually in Task 11).
- [ ] **Step 3: Commit** `feat(brand): brand @theme tokens + .brand-surface scope`.

---

### Task 8: Theme cookie helper (`theme.ts`)

**Files:**
- Create: `lib/brand/theme.ts`
- Test: `lib/brand/theme.test.ts`

**Interfaces:**
- Produces: `export const THEME_COOKIE = "brand-theme";`
  `export type ThemeChoice = "light"|"dark"|"system";`
  `export function resolveThemeAttr(choice: string|undefined): "light"|"dark"|null` — `"light"`→"light", `"dark"`→"dark", anything else (incl. "system"/undefined)→`null` (means: let `prefers-color-scheme` decide; no `data-theme` attr).

- [ ] **Step 1: Write failing test** for the three mappings + unknown/undefined → `null`.
- [ ] **Step 2: Run** `npx vitest run lib/brand/theme.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `theme.ts`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(brand): theme cookie helper`.

---

### Task 9: `BrandStyle` + fonts + `data-theme` in root layout

**Files:**
- Create: `app/components/brand/BrandStyle.tsx`
- Modify: `app/layout.tsx`

`BrandStyle` (server component): `const t = resolveTokens(await getCanon()); return <style id="brand-tokens" dangerouslySetInnerHTML={{__html: emitBrandCss(t)}} />;`

`app/layout.tsx` changes:
- import `Marcellus, Lato, Jost, Noto_Serif_SC` from `next/font/google` (mirror the existing `Geist` pattern), each with `variable` (`--font-brand-display` etc.), appropriate `weight`/`subsets`; add their `.variable` classes to `<html className>`.
  - **Note:** these `next/font` `variable`s and the `@theme --font-brand-*` seeds must name the same families; the `@theme` stacks reference the family names the fonts load. (If a font `variable` and a `@theme` token both target `--font-brand-display`, keep ONE source — prefer the `next/font` `variable` on `<html>` and drop that token's seed value conflict by letting `next/font` own the `--font-brand-*` var; the `@theme` entry then reads `var(--font-brand-display)`.) Implementer: wire fonts so `font-brand-display` renders Marcellus; verify in Task 11.
- `const themeAttr = resolveThemeAttr((await cookies()).get(THEME_COOKIE)?.value);` then `<html … {...(themeAttr ? {"data-theme": themeAttr} : {})}>`.
- render `<BrandStyle/>` inside `<head>` (add an explicit `<head>` or use Next metadata/`<head>`-safe placement) so tokens are present before paint.

- [ ] **Step 1:** Implement `BrandStyle.tsx`.
- [ ] **Step 2:** Wire fonts + `data-theme` + `<BrandStyle/>` into `app/layout.tsx` (do not remove Geist/ops setup).
- [ ] **Step 3:** `npm run verify` — Expected: PASS (lint+types+tests).
- [ ] **Step 4:** Confirm in the browser preview (Task 11 covers full verification) that `<style id="brand-tokens">` is present in the DOM.
- [ ] **Step 5: Commit** `feat(brand): inject brand tokens + fonts + data-theme in layout`.

---

### Task 10: `ThemeToggle` + `useBrandTheme`

**Files:**
- Create: `app/components/brand/ThemeToggle.tsx` (client)
- Create: `app/components/brand/useBrandTheme.ts` (client)

`ThemeToggle`: three-state control (light / dark / system). On change: set cookie `THEME_COOKIE` (`document.cookie`, path=/), and apply immediately — `resolveThemeAttr(choice)` → set/remove `document.documentElement.dataset.theme` — so no reload needed. Use `.btn-secondary`/`.btn-xxs` ops primitives for the control itself (it lives in ops chrome).

`useBrandTheme()`: returns `"light"|"dark"` — reads `document.documentElement.dataset.theme`; if absent, reads `window.matchMedia("(prefers-color-scheme: dark)")`; subscribes to changes. For JS consumers (e.g. future brand charts).

- [ ] **Step 1:** Implement both.
- [ ] **Step 2:** `npm run verify` — Expected: PASS.
- [ ] **Step 3: Commit** `feat(brand): theme toggle + useBrandTheme hook`.

---

### Task 11: Demo brand surface `/brand/preview`

**Files:**
- Create: `app/brand/preview/page.tsx`

A full-page `.brand-surface` route proving the system end-to-end: renders the `<ThemeToggle/>`, a swatch grid for all 13 roles (each cell `bg-brand-<role>` with its label in `text-brand-high-contrast`/`text-brand-content`), and a type specimen block (`font-brand-display` heading, `font-brand-body` paragraph, `font-brand-wordmark` wordmark). No new tokens; consumes only `--color-brand-*` / `font-brand-*` utilities.

- [ ] **Step 1:** Implement the page.
- [ ] **Step 2:** `npm run build && npm run verify` — Expected: PASS.
- [ ] **Step 3: Browser verify** (per repo preview workflow): start dev server, open `/brand/preview`.
  - Confirm the page background is Paper `#f5f0e6` and headings render in Marcellus (read computed `font-family` via the preview tools).
  - Toggle to **dark** → background becomes deep indigo (canvas dark), text light, primary lifted; toggle to **light** → reverts; **system** → follows OS. Capture a light and a dark screenshot.
  - Confirm the surrounding ops chrome (NavBar) stays dark zinc in all states (two namespaces isolated).
- [ ] **Step 4: Commit** `feat(brand): brand token preview surface`.

---

## Definition of Done (Phase 0)

- `npm run verify` green; `lib/**` coverage ≥ 86%.
- `/brand/preview` renders Joho light/dark, driven by the seeded canon, with the ops chrome unaffected — light + dark screenshots captured.
- Migration `20260808_brand_canon_versions.sql` committed, **not applied** (human-gated; note it in the PR for prod apply).
- No `--color-*` ops token or ops-chrome file modified; no raw colors added in feature code.

## Spec self-review

- **Coverage:** canon storage → Task 5; role contract + semantic naming → Tasks 1/3/7; resolver 3 outputs → tokens (3), brief (4), assets deferred to Phase 2 (spec Output 3 is a Phase 2 deliverable — noted, not a Phase 0 gap); dark derive-then-override → Tasks 2/3; runtime injection → Task 9; cookie light/dark + scope → Tasks 8/9/10/7; demo surface → Task 11; two-namespace isolation → asserted in Task 11 Step 3. `getCanon` fallback/caching → Task 6.
- **Deferred by design (not gaps):** `brand_assets`/`brand_labels` tables, `assets.ts`, zod write-validation, the canon editor, and the guide viewer are **Phase 1/2** — out of Phase 0 scope per the spec.
- **Type consistency:** `RoleName`/`FontRole`/`BrandCanon`/`ResolvedTokens` defined in Task 1 and consumed unchanged in Tasks 2/3/4/6/9; `resolveThemeAttr`/`THEME_COOKIE` defined in Task 8, consumed in Tasks 9/10; `emitBrandCss`/`resolveTokens` defined in Task 3, consumed in Task 9.
- **Placeholder scan:** the only literal "…seedCanon JSON…" placeholder (Task 5) is an explicit instruction to paste Task 1's serialized constant, not an unresolved TODO.
