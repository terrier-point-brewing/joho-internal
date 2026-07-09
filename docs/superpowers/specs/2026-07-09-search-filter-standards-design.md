# Search / Filter / Sort Standards — Design

**Date:** 2026-07-09
**Status:** Approved (design), pending implementation plan
**Author:** brainstormed with Will

## Problem

Search, filter, sort, and categorization UI diverge across the app even when
pointed at the same data for similar use cases. Examples the user flagged:

- **Brewing → Batch Log** — two categorical `<select>` filters (beer, status),
  no free-text search, column sort via a *locally-defined* `SortTh`.
- **Export Bay** — free-text search coded to recipe name + inline `FilterChips`
  segmented controls for Status/Channel/Sort.
- **Production Inventory** — categorical filters only, no free-text search.
- **Taproom Management Inventory** — a single free-text box blended across two
  different entities (recipe name **or** partner name).

### Root cause

There is almost no shared machinery to diverge *from*. Every list hand-rolls
`<input className="inp">` + local `useState` + inline `.toLowerCase().includes()`.
An inventory of the app found ~22 search/filter/sort locations and only three
genuinely shared primitives (`useSort`/`SortTh` in `app/reports/`,
`MappingFilter`, `YearSelect`), each trapped in one feature area, plus two
*reinvented* ones:

- A second, **incompatible** `SortTh` in `BatchLogTab.tsx` (different prop
  contract from the reports `SortTh`).
- An inline `FilterChips` defined inside `ExportBayTab.tsx`.

No `SearchInput` or `FilterBar` exists in `app/components/ui/`. **Filter state is
100% local component state** — nothing persists to the URL, so every reload or
shared link resets filters. Naming is inconsistent across the codebase
(`search` vs `query`; `filterStatus` vs `statusFilter` vs `status`; `sortBy`
string vs `sort={col,dir}` object vs `sortKey`/`sortDir`).

## Goals

Establish and implement an app-wide standard governed by three user preferences:

1. **Prefer categorical filters** where the field has a bounded, known value set.
2. **Lean toward enabling sort** on tabular lists.
3. **Free-text search is coded to specific data fields** — do not blend
   semantically-different fields into one search box.

## Non-goals

- Rebuilding domain-specific selectors that are already shared and appropriate
  (`YearSelect`, `PeriodSelector`, `MappingFilter`). They are reused as-is and
  merely placed inside the shared `FilterBar` for layout consistency.
- Token-swapping data-category / urgency color palettes (channels, keg urgency,
  BBL columns). The existing `docs/UI_STANDARD.md` exception still applies —
  `FilterChips` for channels uses `CHANNEL_COLOR`, not status tokens.

## Approach

**Composable primitives + a thin hook** (chosen over a heavier config-driven
`<DataToolbar>` framework). This mirrors how `Badge`/`Card`/`Modal`/`Banner`
already work in this codebase: presentational primitives composed per page,
governed by a written standard plus a CI grep guard. No rendering framework —
pages compose their own layout from the primitives.

## Architecture

### Pure logic — `lib/table/applyControls.ts` (+ `applyControls.test.ts`)

The filter + sort engine. No React. Signature (final types settled in the plan):

```ts
applyControls<T>(rows: T[], config: ControlsConfig<T>, state: ControlsState): T[]
```

Responsibilities, consolidating the scattered inline logic:

- **Text match** — case-insensitive substring. A search box may target one field
  or an **identity-blend** array of fields (OR across *that one box's* fields).
- **Categorical filters** — single-select and multi-select; the `"all"` sentinel
  is a passthrough (no filtering).
- **Sort** — single active key, asc/desc, with number-priority coercion. Absorbs
  the existing `coerce()` helper from `app/reports/components/SortControls.tsx`.
- Handles empty/null rows safely.

### Client hook — `app/components/ui/useTableControls.ts`

Owns control state, synced to the URL query string via `next/navigation`
(`useSearchParams` + `router.replace`, `{ scroll: false }`). Returns:

```ts
{
  rows,          // filtered + sorted, derived via applyControls
  search,        // Record<boxParam, string>
  filters,       // Record<dimensionParam, string | string[]>
  sort,          // { key: string; dir: "asc" | "desc" } | null
  setSearch, setFilter, toggleSort, reset,
  activeCount,   // number of active filters/search terms (drives "Clear (N)")
}
```

Param keys are **namespaceable** (optional prefix) so two tables can coexist on
one page without colliding.

### Presentational primitives — `app/components/ui/`

Each composes `.inp` / token utilities, no raw colors, no hand-rolled styling.

| Component | Purpose |
|---|---|
| `SearchInput.tsx` | Debounced (~200 ms) text box. Placeholder **must name** the searched field(s): "Search recipes…". |
| `FilterChips.tsx` | Segmented chip control (single or multi-select). Promoted from the inline Export Bay version. |
| `FilterSelect.tsx` | Dropdown for a categorical dimension (used when options are many). |
| `FilterBar.tsx` | Layout container — flex-wrap row, spacing, and a "Clear (N)" button wired to `reset`/`activeCount`. Pages fill it with the above. |
| `SortableTh.tsx` | Sortable `<th>`, promoted + unified from `app/reports/components/SortControls.tsx`. Replaces the duplicate `SortTh` in `BatchLogTab.tsx` and the Export Bay `sortBy`-chips approach. |

## The Standard (to be added to `docs/UI_STANDARD.md`)

### Search (free-text)

- Entity-scoped and field-coded. **One box = one entity.** The placeholder names
  what it searches ("Search recipes…", never bare "Search…").
- **Different entities → separate controls.** Taproom Inventory's
  recipe-name-OR-partner-name box splits: partner becomes a categorical filter,
  recipe stays a text box.
- **Identity-field blend allowed within one entity** — account number + name,
  item + variation of the same SKU may share one box (they name the same thing).
- Case-insensitive substring, debounced ~200 ms. Server-side search (e.g.
  Partners → Square API) keeps its own fetch path but uses the `SearchInput` shell.

### Categorical filters (preferred)

- If a field has a **bounded, known value set**, use a categorical filter, never
  free text.
- **Idiom rule:** ≤ 5 mutually-exclusive options → `FilterChips` (segmented);
  > 5 options or tight space → `FilterSelect` (dropdown). Multi-select via
  chip-toggle or multi-select dropdown.
- **"All" is always the default and the first option.**

### Sort

- **Lean toward enabling sort on every tabular list.** Column headers use
  `SortableTh`. One active sort column at a time, toggling asc → desc. Each table
  declares a default sort.

### Persistence & naming

- All three (search, filter, sort) sync to the URL via `useTableControls`.
- Param conventions:
  - Search: **`q`**, or **`q_<field>`** when a page has multiple search boxes.
  - Filter: **the dimension name** (`status`, `channel`, `partner`).
  - Sort: **`sort=key`** ascending, **`sort=-key`** descending (leading `-`).
- Multi-table pages namespace their param keys with a prefix.
- This retires the `filterStatus`/`statusFilter`/`sortBy`/`sort={col,dir}` zoo.

### Enforcement

- A CI grep guard (mirroring the no-raw-colors check) flags, in feature
  components:
  - new raw `<input type="search">`,
  - inline `.toLowerCase().includes(` filter logic,
  - any local `SortTh` / `FilterChips` redefinition.
- Warn-only during the sweep; **blocking** once the retrofit completes (PR 4).

## Retrofit Sequencing

Full sweep, landing as independently-mergeable PRs. Each leaves the app fully
working; no cross-PR breakage.

- **PR 0 — Foundation.** `applyControls` + tests, `useTableControls`, the four
  primitives + `SortableTh`, the `docs/UI_STANDARD.md` section. Zero behavior
  change to existing pages. Grep-guard added **warn-only**.
- **PR 1 — The named four:** Batch Log, Export Bay, Production Inventory, Taproom
  Inventory. Proves the standard on the flagged divergence cases, including the
  recipe/partner split and the two-`SortTh` collapse.
- **PR 2 — Rest of production:** Shipments, Export Invoices, Stock Adjustments,
  Packaging Variations, Commitments (migrate off the reports `useSort` import),
  Partners (server-side search shell), Mapping Drawer.
- **PR 3 — Finance:** transactions (invoices / expenses / orders), statements,
  account-mapping + `AccountSelect`. `MappingFilter` / `YearSelect` get wrapped
  in `FilterBar` for layout, not rebuilt.
- **PR 4 — Taproom remainder + reports cleanup + enforcement:** remaining
  taproom tabs, delete `app/reports/components/SortControls.tsx` (re-homed in
  PR 0), flip the CI grep-guard from warn-only to **blocking**.

## Testing

- **`applyControls.test.ts`** is the core coverage: text match, identity-blend
  OR, categorical single + multi, `"all"` passthrough, sort asc/desc,
  number-priority coercion, empty/null rows. Satisfies the CLAUDE.md
  co-located-`lib`-test rule and keeps the `vitest.config.ts` threshold up.
- **`useTableControls`** — URL round-trip test (set → serialized param → parsed
  param → state).
- Each retrofit PR is **behavior-preserving**; extracting a page's inline filter
  logic into `applyControls` *adds* coverage rather than removing it. Retrofits
  verified in the browser preview per the app's verification workflow.

## Files touched (PR 0)

New:
- `lib/table/applyControls.ts`
- `lib/table/applyControls.test.ts`
- `app/components/ui/useTableControls.ts`
- `app/components/ui/SearchInput.tsx`
- `app/components/ui/FilterChips.tsx`
- `app/components/ui/FilterSelect.tsx`
- `app/components/ui/FilterBar.tsx`
- `app/components/ui/SortableTh.tsx`

Modified:
- `docs/UI_STANDARD.md` — new Search/Filter/Sort section.
- CI lint/grep script — new guard (warn-only).
