# UI Standard — TPB Square Reports

The single canonical standard for typography, color, spacing, page structure, and
component sizing. Derived from the Phase 1 inventory ([route manifest](ui/ROUTE_MANIFEST.md),
[inconsistency catalog](ui/INCONSISTENCY_CATALOG.md)) by consolidating onto the **existing
dominant patterns** — this is consolidation, not redesign.

**Source of truth:** `app/globals.css` (tokens + primitive classes) and `app/components/**`
(shared React components). No raw colors, no one-off spacing, no hand-rolled primitives in
feature code. Charts (Recharts props) and canvas UIs (EquipmentSchedule, Gantt/Calendar,
floorplan) are the only exempt surfaces.

> **Decisions ratified (2026-06-29):** primary button = solid amber w/ dark text · page
> title = `font-semibold` · added `success`(green) + `info`(blue) tokens · **full
> token-variable rewrite** (every raw `zinc/amber/red` utility becomes a semantic
> token utility; no visual change, full re-themeability).
>
> **Superseded 2026-07-09:** the "primary button = solid amber" decision is replaced by the
> one-compact-hollow-button standard (`.btn-primary`/`.btn-secondary`/`.btn-danger`, outline
> only, no solid fill, no md size). See §5 and
> `docs/superpowers/specs/2026-07-09-button-style-standard-design.md`.

---

## 0. Token architecture (Tailwind v4 `@theme`)

The current `:root` vars generate **no utilities** (that is why they were unused). They move
into an `@theme` block so each token emits `bg-*`/`text-*`/`border-*`/`ring-*` utilities and
supports opacity modifiers (`bg-surface/30`). Hex values are preserved; tokens are added to
cover every shade actually in use so the rewrite is color-faithful.

```css
@theme {
  /* Neutrals — surfaces */
  --color-canvas:        #09090b; /* zinc-950  page background */
  --color-surface:       #18181b; /* zinc-900  cards, panels, headers */
  --color-surface-mid:   #27272a; /* zinc-800  inputs, chips, hover rows */
  --color-surface-high:  #3f3f46; /* zinc-700  raised / pressed */

  /* Neutrals — borders (utilities: border-line / border-line-strong / border-line-subtle) */
  --color-line:          #27272a; /* zinc-800  default hairline */
  --color-line-strong:   #3f3f46; /* zinc-700  input/card border */
  --color-line-subtle:   #52525b; /* zinc-600  emphasized divider */

  /* Neutrals — text (full ramp, lossless) */
  --color-text-primary:  #f4f4f5; /* zinc-100  page/section titles */
  --color-text-strong:   #e4e4e7; /* zinc-200  emphasized values */
  --color-text-body:     #d4d4d8; /* zinc-300  body emphasis */
  --color-text-secondary:#a1a1aa; /* zinc-400  default body / labels */
  --color-text-muted:    #71717a; /* zinc-500  captions, descriptions */
  --color-text-faint:    #52525b; /* zinc-600  placeholders, em-dashes */
  --color-text-disabled: #3f3f46; /* zinc-700  disabled glyphs */

  /* Accent (amber) */
  --color-accent:          #fbbf24; /* amber-400 accent text/icons */
  --color-accent-emphasis: #f59e0b; /* amber-500 active states, button base */
  --color-accent-border:   #d97706; /* amber-600 accent borders */
  --color-accent-soft:     #fcd34d; /* amber-300 accent-on-dark text */
  --color-accent-muted:    #78350f; /* amber-900 accent chip backgrounds */

  /* Danger (red) */
  --color-danger:          #f87171; /* red-400  danger text (de-facto standard) */
  --color-danger-emphasis: #ef4444; /* red-500  solid danger */
  --color-danger-border:   #7f1d1d; /* red-900  danger box border */
  --color-danger-surface:  #450a0a; /* red-950  danger box background */

  /* Success (green) — NEW */
  --color-success:         #4ade80; /* green-400 success text */
  --color-success-emphasis:#16a34a; /* green-600 solid success */
  --color-success-border:  #14532d; /* green-900 success box border */
  --color-success-surface: #052e16; /* green-950 success box background */

  /* Info (blue) — NEW */
  --color-info:            #60a5fa; /* blue-400  info text */
  --color-info-emphasis:   #2563eb; /* blue-600  solid info */
  --color-info-border:     #1e3a8a; /* blue-900  info box border */
  --color-info-surface:    #172554; /* blue-950  info box background */
}
```

`color-scheme: dark` and the `body` defaults stay. Geist fonts unchanged
(`--font-geist-sans`, `--font-geist-mono`).

---

## 1. Typography

Use the type scale below. **No arbitrary sizes** (`text-[10px]`, `text-[9px]`,
`text-[11px]`) outside chart/canvas-exempt code — for genuinely dense table meta,
use the sanctioned `text-2xs` tier (below), never an arbitrary `text-[Npx]`.

| Role | Classes | Notes |
|---|---|---|
| Page title | `text-base font-semibold text-primary` | **Only via `<PageHeader>`** |
| Page description | `text-sm text-muted` | Only via `<PageHeader>` |
| Section heading (h3) | `text-sm font-semibold text-strong` | |
| Eyebrow / group label | `text-xs font-semibold uppercase tracking-wide text-secondary` | one tracking value |
| KPI / stat value | `text-base sm:text-xl font-semibold text-primary` | responsive step required |
| Body default | `text-sm text-secondary` | |
| Body emphasis | `text-sm text-body` / values `text-strong` | |
| Caption / muted | `text-xs text-muted` | one caption style — no zinc-600 captions |
| Placeholder / faint | `text-xs text-faint` | |
| Dense caption (10px) | `text-2xs text-faint` / `-muted` | **only** for dense table meta rows, pill labels, and inline status glyphs where `text-xs` is too tall (finance ledgers/mappings). The single sanctioned sub-`xs` size; defined once in `globals.css`. Not for body copy. |
| Numeric cells | `text-sm font-mono tabular-nums` | applies to **all** money/number columns incl. reports |

Weights: `font-medium` and `font-semibold` only (plus `font-bold` for the TPB wordmark).
Drop `font-medium` page titles, `font-semibold text-lg` titles, and the assorted
`zinc-200/300/400 × medium/semibold` section-heading variants.

---

## 2. Color

**Full token rewrite.** Every color in feature code uses a token utility. Raw
`zinc-*`/`amber-*`/`red-*`/`green-*`/`blue-*`/`gray-*` and hex/rgb literals are **banned**
in feature `.tsx` (except exempt surfaces). Mapping is mechanical and color-faithful:

| Raw (deprecated) | Token utility |
|---|---|
| `bg-zinc-950` | `bg-canvas` |
| `bg-zinc-900` (+`/NN`) | `bg-surface` (+`/NN`) |
| `bg-zinc-800` | `bg-surface-mid` |
| `bg-zinc-700` | `bg-surface-high` |
| `border-zinc-800` | `border-line` |
| `border-zinc-700` | `border-line-strong` |
| `border-zinc-600` | `border-line-subtle` |
| `text-zinc-100` | `text-primary` |
| `text-zinc-200` | `text-strong` |
| `text-zinc-300` | `text-body` |
| `text-zinc-400` | `text-secondary` |
| `text-zinc-500` | `text-muted` |
| `text-zinc-600` | `text-faint` |
| `text-zinc-700` | `text-disabled` |
| `text-amber-400` | `text-accent` |
| `text-amber-300` | `text-accent-soft` |
| `text-amber-500/600`, `border-amber-500` | `text-accent-emphasis` / `border-accent-emphasis` |
| `border-amber-600` | `border-accent-border` |
| `bg-amber-900/NN` | `bg-accent-muted/NN` |
| `text-red-400` (and `-300/-500`) | `text-danger` |
| `bg-red-950/NN`, `border-red-700/900` | `bg-danger-surface/NN`, `border-danger-border` |
| `text-green-*` (positive) | `text-success` |
| `bg-green-900/950`, `border-green-*` | `bg-success-surface`, `border-success-border` |
| `text-blue-*` (info/links) | `text-info` |
| `bg-blue-600` (primary) | **→ `.btn-primary`** (blue was off-palette as a primary) |

**Semantic rules**
- Accent = amber. The active nav/tab underline uses `accent-emphasis` (amber-500); accent
  text/icons — and the hollow `.btn-primary` outline (`border-accent-border` + `text-accent`) —
  use `accent` (amber-400).
- Danger = red for errors/destructive only.
- Success = green for positive/approved/on-target states.
- Info = blue for neutral-informational badges/links only — **never** as a primary action.
- Off-palette `purple/violet/cyan/orange/yellow/emerald` used as **data-category** coloring
  (badge maps, BBL channel columns, urgency ramps) stay as deliberate category palettes but
  must be centralized in a shared constant (see §6), not inlined per file.

**Exempt:** Recharts series/axis/grid props and canvas inline styles
(EquipmentSchedule/**, GanttTab, CalendarTab, BrewStatus floorplan) may keep hex/rgb.

---

## 3. Spacing

Allowed scale (Tailwind steps): **0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 6, 8**. (Half-steps
permitted for dense table rows only.) Banned: arbitrary `*-[Npx]` spacing and inline
`style={{padding…}}` (use `pl-*` or a CSS var for tree indents). No `gap-0` (use no gap).

| Use | Value |
|---|---|
| Page horizontal padding | `px-4 sm:px-6` |
| Page vertical padding | `py-4 sm:py-8` (via `<main>`) |
| Section stack | `space-y-6` (major) / `space-y-4` (within a card) |
| Card inner padding | `p-4` (default) · `p-3` (dense) · `p-6` (modal/form) |
| Table cell | `px-3 py-2` (default) · `px-4 py-2.5` (comfortable) — pick **one per table** |
| Flex/grid gap | `gap-2` (tight) · `gap-3` · `gap-4` |
| Description top margin | `mt-1` |

Mobile horizontal-bleed: standardize on `-mx-4 sm:mx-0 px-4 sm:px-0`. The page-level
"title + subtabs stay frozen while scrolling" behavior lives in one shared component
(`<StickyHeader>`, §4) — not per-file sticky offsets.

---

## 4. Page structure (canonical template)

Production's shell is the model (100% consistent there). Every content page conforms:

```tsx
// page.tsx
<main className="px-4 sm:px-6">
  <StickyHeader>
    <SubNav entries={AREA_NAV} mobile />            {/* area tabs (mobile) */}
    <PageHeader title="…" description="…" />
    <SubNav entries={SECTION_NAV} />                 {/* sub-tabs, when present */}
  </StickyHeader>
  <div className="mt-4 pb-4 sm:pb-8">
    <FeatureTab />                                  {/* logic lives in a Tab/component */}
  </div>
</main>
```

`<StickyHeader>` (`app/components/StickyHeader.tsx`) pins the whole block — area nav,
title/description, section sub-tabs — to the top of the page's scroll container so they
never scroll away, regardless of content height. It's the single shared mechanism for
this; don't hand-roll a `position: sticky` wrapper or per-element sticky offsets in a
page. (Full-height shells that already isolate scrolling structurally — `flex flex-col
h-full` → `shrink-0` header → `flex-1 overflow-auto` content, e.g. Finance's Financials/
Transactions/Period Close and Settings — get the same frozen-header behavior for free
from that structure and don't need `<StickyHeader>` too.)

Rules:
- **Page = shell; feature logic lives in a co-located `*Tab`/component.** (Fix
  `brewing/transfers` which inlines its table.)
- **Shared section chrome via `layout.tsx`.** Add `layout.tsx` for taproom
  `performance/`, `targets/`, and finance sub-sections so the `PageHeader` + dual-`SubNav`
  shell and description strings are defined once, not copy-pasted per leaf page.
- **No `<h1>`/`<h2>` hand-rolled headers** — always `<PageHeader>`.
- **The frozen header holds title → description → the page's one subtab bar, and nothing
  else.** Action buttons, selects, and status text all live in the scrollable content below,
  even when they'd naturally sit beside the title. Page-level actions go at the top of that
  content as `flex justify-end gap-2 mb-4`. `SettingsHeader` deliberately has **no** `actions`
  prop — don't re-add one or a lookalike escape hatch on `StickyHeader`. *Named exceptions,
  granted explicitly: Financials' DataQualityPanel + year select + Refresh, and the payroll
  period-detail `PeriodSelector`.*
- **`StickyHeader` `divider` prop:** a page whose header has no subtab bar underneath has
  nothing to draw the border a `TabBar`/`SubNav` supplies for free — pass `divider` so the
  frozen header still reads as distinct from the content below.
- **A page-local view switcher nested under a real subtab bar is a `<ButtonGroup>`**, never a
  second `TabBar` — two stacked underline rows read as a nav level that doesn't exist.
- **Container width:** full-bleed by default (production convention). Where a max-width is
  wanted, use a single shared constant `max-w-5xl` — not a per-tab grab bag.
- Finance's `flex flex-col h-full` family migrates to the `<main>` template unless the
  full-height scroll behavior is load-bearing (flag in Phase 4 if so).
- Navigation is **tabs (`SubNav`/`TabBar`)**, not `<select>` switchers (fix
  `taproom/reports`).

---

## 5. Component sizing & primitives

All interactive primitives come from `globals.css` classes or shared components. Sizes are
baked in so consumers can't drift.

### Buttons (`globals.css`)
One compact default size, three hollow tiers. **No solid fills.** Every action
button is `py-1 px-2.5 text-xs font-medium`, transparent fill, 1px outline.

| Class | Style | Use |
|---|---|---|
| `.btn-primary` | amber outline — `border-accent-border text-accent`, hover amber wash + `text-accent-soft` | the main action (New, Save, Run, Ship, Confirm) |
| `.btn-secondary` | neutral outline — `border-line-strong text-secondary`, hover `border-line-subtle`/`text-body` | cancel, close, secondary/neutral actions |
| `.btn-danger` | danger outline — `border-danger-border text-danger`, hover danger wash | destructive (Delete, Remove) |

**Size:** one modifier only — `.btn-xxs` (`py-0.5 px-1.5`, 10px), which composes with any
tier (`btn-primary btn-xxs`). Use it **only** where *every* control in the same row is also
10px — in practice that means button-only rows: a table's action column and floorplan/keg
tile action strips. It is not a general small button; do not reach for it to make a
page/toolbar button smaller.

All share `:disabled → opacity-40`, `:focus-visible → 2px accent outline`. There is **no
`.btn-amber`/`.btn-ghost`/`.btn-sm`/`.btn-xs` and no md size** — do not hand-roll bordered or
filled `<button>` boxes; use a tier class. Filter/toggle chips and tabs are separate patterns,
not buttons. A text-link that performs an action **is** a button and takes a tier — there is no
untiered "just text" action, and no fourth informal amber-link tier.

**Geometry:** the tier owns the button's padding and height — never override them. The only
width utility allowed on a `.btn-*` is `w-full`, for a full-width form submit (modal footers,
login). No `w-32`, `min-w-*`, `max-w-*`, `h-*`, `px-*`, `py-*`, or inline `style` padding: a
button sizes to its label, so a fixed width pads short labels with dead space and makes the
same action look different from page to page. Enforced by `eslint.config.mjs`
(`no-restricted-syntax`); if you genuinely need an exception, disable it on the line with a
comment saying why.

#### Adjacency (the rule that governs size)
This overrides the per-role defaults below whenever they conflict. Within one flex row:

- **Button vs button** — must share a size tier. Never mix default with `.btn-xxs`.
- **Button vs `.inp-sm` or `ToggleChip` (12px)** — the button is **default** size. A 10px
  `.btn-xxs` beside a 12px control is the most common defect in this codebase; it is always wrong.
- **Button vs `.inp` (14px)** — a default 12px button is **correct**. This is the sanctioned
  one-tier-below pairing (there is no 14px button). Do not "fix" it.

The ladder, so adjacency is checkable: `.inp` 14px → `.btn-*` default / `.inp-sm` / `ToggleChip`
12px → `.btn-xxs` 10px. There is no 10px input, which is why `.btn-xxs` is rare.

#### Role → canonical treatment
| Role | Treatment |
|---|---|
| Page-level action (New, Refresh, Upload) | Top of **scrollable content**, `flex justify-end gap-2 mb-4`, default `.btn-*`, exactly **one** `.btn-primary` per row. Never in the frozen header (§4). |
| Toolbar / section / card-header / panel-footer action | Default-size `.btn-*` |
| Table row action (inside a `<td>`) | `.btn-xxs` + tier, grouped `flex gap-1` (no `·` separators). If the cell also holds an `.inp-sm`, use default size instead. |
| Dense tile action (floorplan/keg/equipment) | `.btn-xxs` + tier |
| Repeated editor row | Default size — these rows contain `.inp-sm`, so adjacency forces 12px. A list's footer "Add …" matches the row buttons it terminates. |
| Modal footer | `<ModalActions>`; else `flex justify-end gap-2`, cancel **first** (`.btn-secondary`), confirm **last**. Both default size. |
| Page-local view switcher under a subtab bar | `<ButtonGroup>` |
| Any other inline exclusive choice (mode, metric, segmented row) | `<ToggleChip>` row — never a `<select>`, a hand-rolled bordered row, or a second `TabBar` |
| Filter controls | `FilterBar` + `SearchInput` / `FilterChips` / `FilterSelect` |
| Non-interactive status pill | `<Badge>` (category colors via `className`) |

There is no success/info button tier: any colored *action* button folds into `.btn-secondary`
(or `.btn-primary` if it is the page's main action). This does not apply to status-encoding
controls — a toggle whose color shows active/inactive, or a status badge — which are not
buttons and keep their status color.

### Inputs (`globals.css`)
- `.inp` (`py-1.5 px-2 text-sm`, surface-mid bg, border-strong, amber focus ring) for form and
  modal fields; `.inp-sm` (`py-1 px-2 text-xs`) for table-embedded inputs, filter bars, and
  dense repeated rows. These two are the **only** input/select/textarea styles. Delete every
  local `inputCls`/`selectCls` const and every hand-rolled `px-2 py-1 text-xs` micro-input.
- **Never `inp` + a font-size override.** `inp text-xs` is a hand-made `.inp-sm` — use the real
  one. Likewise never stack `inp inp-sm` (only CSS source order makes that work), and never
  restate a primitive's own size (`inp text-sm`).
- Checkboxes and `<input type="color">` have no primitive; style them inline and consistently
  (see `PaletteFacet` for the color-swatch sizing).

### Cards
`<Card>` component → `bg-surface border border-line rounded-lg`, padding via prop
(`p-4` default). Replaces ~40 hand-rolled card divs.

### Modal
One `<Modal>` (consolidate `production/components/shared.tsx` `Modal` + the core/payroll
re-impls): overlay `fixed inset-0 bg-black/60 …`, panel `bg-surface border border-line-strong
rounded-lg`, body `p-6`, footer via `<ModalActions>` using `.btn-*`.

### Tabs
One presentational tab item shared by `SubNav` (link) and `TabBar` (button):
`px-4 py-2.5 text-sm font-medium … border-b-2 -mb-px`, active
`text-accent border-accent-emphasis`, inactive `text-muted border-transparent
hover:text-body`. `SettingsTabs`, `PayrollPeriodView` tabs, and the 4 finance hand-rolled
navs all migrate onto `SubNav`/`TabBar`.

### Badges / pills
`<Badge>` (or `StatusBadge`) → `text-xs px-2 py-0.5 rounded-full` + a tone prop
(`accent|success|danger|info|neutral`) reading the shared semantic color map. Replaces the
3 per-feature badge color maps.

### Error / status banners
`<Banner tone="danger|success|info">` → e.g. danger = `text-danger bg-danger-surface/30
border border-danger-border/50 rounded px-3 py-2 text-sm`. Replaces ~12 copies.

---

## 6. Deprecated patterns → replacement

| Deprecated | Replacement |
|---|---|
| Raw `zinc/amber/red/green/blue/gray` color utilities; hex/rgb literals (non-exempt) | token utilities (§2) |
| Arbitrary `text-[Npx]`, `*-[Npx]` spacing, inline `style` padding | type scale (§1) / spacing scale (§3) |
| Hand-rolled `<h1>/<h2>` page headers | `<PageHeader>` |
| Hand-rolled tab rows (SettingsTabs, PayrollPeriodView, SalesNav, StatementsNav, SettingsNav, PayrollNav) | `<SubNav>` / `<TabBar>` |
| Solid amber / any inline bordered-or-filled `<button>` CTA; `.btn-amber`/`.btn-ghost`/`.btn-sm`/`.btn-xs`; md size | `.btn-primary` (amber outline) / `.btn-secondary` (neutral) / `.btn-danger` — one compact size |
| Local `inputCls`/`selectCls`, raw inputs, micro-inputs | `.inp` (/`.inp-sm`) |
| Hand-rolled card divs | `<Card>` |
| Hand-rolled modals | `<Modal>` |
| Copy-pasted error/success banners | `<Banner>` |
| Per-file status/type badge color maps | shared semantic color map + `<Badge>` |
| 7× report table chrome + `tdCls` + `currency()` | `<ReportTable>` + `formatCurrency` util |
| 3× CoA account picker (`CoASelect`/`AccountSelect`) | shared `<AccountSelect>` (finance) |
| 3× statement table machinery, 4× `MONTH_NAMES`, 2× batch-color hex cycle | shared finance utils / shared constants |
| `<select>`-based view switchers | `<SubNav>`/`<TabBar>`, or `<ButtonGroup>` when nested under an existing subtab bar |
| Untiered text-link row actions (`Adjust · Edit · Del`) | `.btn-xxs` + tier, grouped `flex gap-1` |
| Bare amber link buttons (`text-xs text-accent-emphasis hover:text-accent`) | `.btn-secondary` (or `.btn-primary` if it is that card's main act) |
| Hand-rolled segmented/bordered exclusive-choice rows | `<ToggleChip>` row |
| `inp text-xs` / `inp inp-sm` / `inp text-sm` | `.inp-sm` / `.inp` |
| Action buttons or selects inside `StickyHeader`/`SettingsHeader` | move into the scrollable content (§4) |
| Width/padding/height overrides on a `.btn-*` (`min-w-32`, `px-3 py-1.5`, `h-8`) | let the tier own the geometry; only `w-full` is allowed |
| Per-section copy-pasted shells + desc strings | section `layout.tsx` |

### Exempt (documented, not migrated)
EquipmentSchedule/** , GanttTab, CalendarTab, BrewStatus floorplan canvas (React Flow /
absolute-positioned), and Recharts axis/grid/series props. These keep inline hex/rgb and
may use sub-`xs` type. Their **shared color constants** (batch-color cycle) should still be
centralized. Additionally, the fixed nav micro-labels in `NavBar` (mobile bottom-nav item
labels and the account role caption) may keep `text-[10px]` — bumping them risks wrapping
the compact bottom bar.

The **brand read-only guide surface** — `app/brand/guide/blocks/**` and the `app/brand/guide/
*View.tsx` read views — is also exempt. It renders the brand's own skin through a deliberate
parallel `font-brand-*` / `border-brand-line` / `text-brand-content` system scoped by
`.brand-surface`, so its chips, copy buttons and download links are intentionally not `.btn-*`.
Mixing ops tiers in would break the skin. This exemption covers the read surface only — the
brand **editors** (`canon/**`, `releases/**`, `templates/**`, `guide/MarksEditor.tsx`) are
ordinary ops UI and follow §5 in full.

Also not migrated, because no primitive fits and forcing one breaks layout: "row-as-button"
accordion disclosures, image-tile pickers, in-chip micro-actions, and two-line "choice cards"
(a bold label plus a hint line, e.g. the inventory adjustment-type pickers).

## Search / Filter / Sort (strict)

All list/table search, filtering, and sorting use the shared primitives in
`app/components/ui/` + the `useTableControls` hook. Do not hand-roll
`<input type="search">`, inline `.toLowerCase().includes()`, or per-file
`SortTh`/`FilterChips`. The engine and URL logic live in `lib/table/`
(`applyControls.ts`, `urlState.ts`) — pure and unit-tested.

**Free-text search — entity-scoped, field-coded.**
- One search box maps to ONE entity. The placeholder must name the field(s):
  `"Search recipes…"`, never a bare `"Search…"`.
- Different entities → separate controls. A recipe-name-OR-partner-name box is
  wrong: partner becomes a categorical filter, recipe stays a text box.
- An entity's own identity fields may share one box (account number + name,
  item + variation of the same SKU) — pass an array accessor for that box.
- Case-insensitive substring, debounced ~200 ms (built into `<SearchInput>`).

**Categorical filters — preferred.**
- If a field has a bounded, known value set, filter categorically, never with
  free text.
- ≤ 5 mutually-exclusive options → `<FilterChips>` (segmented); > 5 options or
  tight space → `<FilterSelect>` (dropdown). Multi-select via `multiple`.
- "All" is always the default and first option (state = empty array).

**Sort — lean toward enabling it.**
- Prefer sortable columns on any tabular list. Headers use `<SortableTh>`, one
  active column at a time, toggling asc → desc. Declare a default via
  `config.sort.default`.

**Persistence & naming.**
- Search/filter/sort state syncs to the URL via `useTableControls` (shareable,
  reload-safe). Params: `q` / `q_<field>` for search, the dimension name for
  filters (`status`, `channel`, `partner`), `sort=key` / `sort=-key` for sort.
- Multi-table pages pass a `prefix` to namespace their params.
- **Give `useTableControls` a stable `config`** — define it module-scope or wrap
  it in `useMemo`. A fresh inline object every render re-runs the filter/sort
  pass and re-creates the returned setters each render (defeating `React.memo`
  on rows). The `accessor` closures are the only per-render cost you want.

**Data-category colors** (channels, urgency ramps) remain the sanctioned
raw-color exception — pass category color classes via `FilterChips`
`options[].className`; do not token-swap them.

**Enforcement:** `npm run check:search-filter` (CI, warn-only during the PR 1–4
retrofit sweep; blocking afterward) flags raw search inputs, inline
`.toLowerCase().includes()`, and local `SortTh`/`FilterChips` in feature code.
