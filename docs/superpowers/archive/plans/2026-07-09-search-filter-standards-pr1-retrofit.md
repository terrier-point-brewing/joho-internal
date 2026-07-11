# Search / Filter / Sort Standards — PR 1 (Retrofit the Four Named Areas) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Migrate the four originally-flagged surfaces onto the shared search/filter/sort foundation (PR #139), proving the standard end-to-end. "Production Inventory" expands to its three child tabs, so this PR retrofits **six components** plus two small additive foundation extensions.

**Architecture:** Each component replaces its hand-rolled search/filter/sort state with `useTableControls` (URL-synced) + the `app/components/ui/` primitives, deriving rows through the pure `lib/table/applyControls` engine. Two components need engine capabilities the foundation doesn't yet have (group-predicate filters, explicit sort setting) — added as backward-compatible extensions in Task 1.

**Tech Stack:** Next.js 16 App Router, TypeScript, Tailwind v4, React 19, Vitest (node, `lib/**` only), `next/navigation`.

## Global Constraints

- **Foundation lives at:** `lib/table/{types,applyControls,urlState}.ts` and `app/components/ui/{useTableControls.ts,SearchInput,FilterChips,FilterSelect,FilterBar,SortableTh}.tsx`. Read `lib/table/types.ts` before writing any config.
- **`useTableControls` config MUST be referentially stable** — module-scope constant when accessors are pure; `useMemo` (with correct deps) when accessors close over component data. An unstable config re-syncs the URL every render.
- **Params:** search `q` (or `q_<field>`), filters keyed by dimension name (`status`, `channel`, `partner`, `beer`, `category`, `type`, `source`), sort `sort=key`/`sort=-key`. **The three production-inventory child tabs share one route (`/production/inventory`)**, so each passes a distinct `prefix` (`ing_`, `pkg_`, `adj_`) to avoid param collisions.
- **Standard rules:** field-coded search (placeholder names the field); ≤5 mutually-exclusive options → `FilterChips`, >5 → `FilterSelect`; "All" = empty `string[]` (auto-rendered by both); lean toward sort where a real table exists.
- **Data-category colors are the sanctioned raw-color exception.** Channel/category/type/urgency palettes (`CHANNEL_COLOR`, `KEG_TAG_BADGE`, `CATEGORY_BADGE_CLASS`, `INGREDIENT_CATEGORY_META`, `TYPE_META`, `SOURCE_COLORS`) must be preserved — pass them to `FilterChips` via `options[].className`. Never token-swap them.
- **Behavior-preserving.** Same rows visible for the same intent; grouped layouts stay grouped; load-bearing derived values (totals, counts, group headers) keep working off the filtered output. Deliberate minor changes (e.g. a dropped secondary tiebreak) are called out per-task and are acceptable.
- **`useSearchParams` needs a Suspense boundary / dynamic route.** If `npm run build` errors with "useSearchParams() should be wrapped in a suspense boundary", wrap the consuming subtree in `<Suspense>` or confirm the route renders dynamically. Verify build after each task.
- **No unit tests for `app/**` components** (vitest is node/`lib`-only). Per-component gate = `tsc --noEmit` + `build` + `lint` + `check:search-filter` (the file's violations must disappear) + `test` (engine still green). Browser verification of the six surfaces is a controller step at the end (see DoD).
- **Commit trailer:** end every commit body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

Modified — foundation (Task 1):
- `lib/table/types.ts` — `FilterSpec.matches?` + make `accessor?` optional.
- `lib/table/applyControls.ts` — honor `matches`.
- `lib/table/applyControls.test.ts` — predicate-filter tests.
- `app/components/ui/useTableControls.ts` — add `setSort(key, dir)`.

Modified — retrofits (Tasks 2–7):
- `app/taproom/components/InventoryTab.tsx`
- `app/production/components/BatchLogTab.tsx`
- `app/production/components/ExportBayTab.tsx`
- `app/production/components/IngredientsTab.tsx`
- `app/production/components/PackagingTab.tsx`
- `app/production/components/StockAdjustmentsTab.tsx`

---

### Task 1: Foundation extensions — predicate filters + explicit sort

**Files:**
- Modify: `lib/table/types.ts`
- Modify: `lib/table/applyControls.ts`
- Test: `lib/table/applyControls.test.ts`
- Modify: `app/components/ui/useTableControls.ts`

**Interfaces:**
- Consumes: existing foundation.
- Produces:
  - `FilterSpec<T>` gains `matches?: (row: T, selected: string[]) => boolean` and `accessor` becomes optional (`accessor?`). When `matches` is set it fully decides membership; otherwise the engine falls back to `selected.includes(accessor(row))`.
  - `useTableControls` return type `TableControls<T>` gains `setSort(key: string, dir: SortDir): void`.

- [ ] **Step 1: Update the type**

In `lib/table/types.ts`, replace the `FilterSpec` interface with:

```ts
/** One categorical filter dimension. Provide `matches` for group/predicate
 *  filters that can't be expressed as single-value equality; otherwise the
 *  engine uses `selected.includes(accessor(row))`. */
export interface FilterSpec<T> {
  /** URL param key, e.g. "status" or "channel". */
  param: string;
  accessor?: (row: T) => string;
  /** true = multiple values may be selected (OR within the dimension). */
  multi?: boolean;
  /** Custom membership test; overrides accessor-equality when present. */
  matches?: (row: T, selected: string[]) => boolean;
}
```

- [ ] **Step 2: Write the failing tests**

In `lib/table/applyControls.test.ts`, add inside the existing `describe("applyControls", …)`:

```ts
  it("uses a custom matches predicate when provided", () => {
    const cfg: ControlsConfig<Row> = {
      filters: [
        {
          param: "vol",
          matches: (r, sel) => sel.some((s) => (s === "big" ? r.volume >= 10 : r.volume < 10)),
        },
      ],
    };
    const out = applyControls(ROWS, cfg, { ...EMPTY, filters: { vol: ["big"] } });
    expect(out.map((r) => r.recipe)).toEqual(["Hazy IPA", "Pilsner"]);
  });

  it("matches predicate with empty selection does not filter", () => {
    const cfg: ControlsConfig<Row> = {
      filters: [{ param: "vol", matches: () => false }],
    };
    expect(applyControls(ROWS, cfg, { ...EMPTY, filters: { vol: [] } })).toHaveLength(3);
  });
```

- [ ] **Step 3: Run to verify failure**

Run: `npm run test -- applyControls`
Expected: the two new tests FAIL (matches not honored).

- [ ] **Step 4: Honor `matches` in the engine**

In `lib/table/applyControls.ts`, replace the categorical-filters loop with:

```ts
  for (const spec of config.filters ?? []) {
    const selected = state.filters[spec.param] ?? [];
    if (selected.length === 0) continue;
    const pred = spec.matches ?? ((row: T, sel: string[]) => sel.includes(spec.accessor!(row)));
    out = out.filter((row) => pred(row, selected));
  }
```

- [ ] **Step 5: Run to verify pass**

Run: `npm run test -- applyControls`
Expected: PASS (14 tests).

- [ ] **Step 6: Add `setSort` to the hook**

In `app/components/ui/useTableControls.ts`:

1. Add to the `TableControls<T>` interface (after `toggleSort`):

```ts
  /** set a specific sort column + direction (for non-column / segmented sorts) */
  setSort: (key: string, dir: SortDir) => void;
```

2. Add the callback (after the `toggleSort` definition):

```ts
  const setSort = useCallback(
    (key: string, dir: SortDir) => push({ ...state, sort: { key, dir } }),
    [push, state],
  );
```

3. Add `setSort` to the returned object.

- [ ] **Step 7: Type-check + full suite**

Run: `npx tsc --noEmit && npm run test`
Expected: clean; all tests pass (coverage ≥ 86).

- [ ] **Step 8: Commit**

```bash
git add lib/table/types.ts lib/table/applyControls.ts lib/table/applyControls.test.ts app/components/ui/useTableControls.ts
git commit -m "$(cat <<'EOF'
feat(table): predicate filters + explicit setSort

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Retrofit Taproom Inventory (split the blended search)

**Files:**
- Modify: `app/taproom/components/InventoryTab.tsx`

**Interfaces:**
- Consumes: `useTableControls` (Task 1), `SearchInput`, `FilterSelect`, `FilterBar`, `ControlsConfig`.
- Produces: nothing downstream.

**Context:** Self-contained client component. Fetches `data` via `useQuery` → `data.rows: InventoryRow[]` (`lib/production/inventoryGrid.ts`: `recipeId, recipeName, recipePartnerName: string|null, totalBbl, cells`). Today a single `<input type="search">` (state `query`, line ~130) blends `recipeName` OR `recipePartnerName`; the `view` memo (lines ~144–166) filters rows AND recomputes `columnTotals`/`grandTotalBbl` from the filtered rows. Rows are grouped visually by `recipePartnerName` (null → "House") in source order; no sort.

**The split:** recipe → `SearchInput` (accessor `recipeName`); partner → `FilterSelect` (accessor `recipePartnerName ?? "House"`, options derived, likely >5). No sort (preserve source-order partner grouping).

- [ ] **Step 1: Add the config (module scope, above the component)**

```tsx
import { useTableControls } from "@/app/components/ui/useTableControls";
import SearchInput from "@/app/components/ui/SearchInput";
import FilterSelect from "@/app/components/ui/FilterSelect";
import FilterBar from "@/app/components/ui/FilterBar";
import type { ControlsConfig } from "@/lib/table/types";
import type { InventoryRow } from "@/lib/production/inventoryGrid";

const INVENTORY_CONTROLS: ControlsConfig<InventoryRow> = {
  search: [{ param: "q", accessor: (r) => r.recipeName }],
  filters: [{ param: "partner", accessor: (r) => r.recipePartnerName ?? "House" }],
};
```

(Use the import path style already present in the file for the local `InventoryRow`/queries; match existing alias usage.)

- [ ] **Step 2: Replace the `query` state + `view` memo**

Remove `const [query, setQuery] = useState("")` and `const q = query.trim().toLowerCase()`. Drive rows through the hook, then keep the existing totals recomputation but source it from the hook's `rows`:

```tsx
  const source = data?.rows ?? [];
  const { rows, search, filters, setSearch, setFilter, reset, activeCount } =
    useTableControls(source, INVENTORY_CONTROLS);

  const partnerOptions = useMemo(
    () =>
      Array.from(new Set(source.map((r) => r.recipePartnerName ?? "House")))
        .sort()
        .map((p) => ({ value: p, label: p })),
    [source],
  );

  // preserve the existing column/grand-total recomputation, but over `rows`
  const { columnTotals, grandTotalBbl } = useMemo(() => {
    /* keep the exact body from the old `view` memo, replacing its filtered
       `rows` variable with the hook's `rows` */
  }, [rows, data?.columns]);
```

Keep every downstream reference (`view.rows` → `rows`, `view.columnTotals` → `columnTotals`, etc.) pointing at these values. The partner-grouped header rendering (compares adjacent `recipePartnerName`) is unchanged because there is still no sort.

- [ ] **Step 3: Replace the search-box JSX with a `FilterBar`**

Replace the old `<input type="search">` block (lines ~192–206) with:

```tsx
      <FilterBar activeCount={activeCount} onClear={reset}>
        <SearchInput
          value={search.q ?? ""}
          onChange={(v) => setSearch("q", v)}
          placeholder="Search recipes…"
        />
        <FilterSelect
          label="Partner"
          options={partnerOptions}
          value={filters.partner ?? []}
          onChange={(v) => setFilter("partner", v)}
        />
      </FilterBar>
```

Keep the existing match-count `<span>` if desired, but drive it off `rows.length`/`source.length`.

- [ ] **Step 4: Gate**

Run: `npx tsc --noEmit && npm run build && npm run lint && npm run test`
Then: `npm run check:search-filter` — confirm `app/taproom/components/InventoryTab.tsx` no longer appears in the WARN list.
Expected: all clean; taproom InventoryTab gone from violations.

- [ ] **Step 5: Commit**

```bash
git add app/taproom/components/InventoryTab.tsx
git commit -m "$(cat <<'EOF'
refactor(taproom): split blended inventory search into recipe search + partner filter

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Retrofit Batch Log (categorical filters + shared SortableTh + search)

**Files:**
- Modify: `app/production/components/BatchLogTab.tsx`

**Interfaces:**
- Consumes: `useTableControls`, `SearchInput`, `FilterChips`, `FilterSelect`, `FilterBar`, `SortableTh`, `ControlsConfig`, `SortState`.
- Produces: nothing downstream.

**Context:** 1945-line client component, self-contained. Row type `BrewBatch` (`app/production/types.ts`). Current controls: `filterBeer`/`filterStatus` `<select>`s + a Clear button (lines ~238–269), exact-match filtering (lines ~227–231), a bespoke `sortBatches` (lines ~140–162) using `STATUS_ORDER = {planning:0, fermenting:1, conditioning:2, complete:3}` with a `planned_brew_date`-desc tiebreak on status ties, and a **local `SortTh`** (lines ~1191–1205) used in `BatchTable`'s thead (lines ~1248–1255) over cols `batch_number, beer_name, planned_brew_date, expected_delivery_date, volume_bbl, status`. No free-text search today.

**Target:** keep beer + status categorical filters; add an identity-blend search over the batch (`batch_number` + `beer_name`); replace the local `SortTh` with the shared `SortableTh`; drive sort through the hook. **Deliberate minor change:** the status-tie `planned_brew_date`-desc tiebreak is dropped (single-key sort); `brewing` is added to the status order (between planning and fermenting) so brewing batches sort in a sensible place instead of last.

- [ ] **Step 1: Add the config (module scope)**

```tsx
import { useTableControls } from "@/app/components/ui/useTableControls";
import SearchInput from "@/app/components/ui/SearchInput";
import FilterChips from "@/app/components/ui/FilterChips";
import FilterSelect from "@/app/components/ui/FilterSelect";
import FilterBar from "@/app/components/ui/FilterBar";
import SortableTh from "@/app/components/ui/SortableTh";
import type { ControlsConfig, SortState } from "@/lib/table/types";

const STATUS_SORT_INDEX: Record<string, number> = {
  planning: 0, brewing: 1, fermenting: 2, conditioning: 3, complete: 4,
};

const STATUS_OPTIONS = [
  { value: "planning", label: "Planning" },
  { value: "brewing", label: "Brewing" },
  { value: "fermenting", label: "Fermenting" },
  { value: "conditioning", label: "Conditioning" },
  { value: "complete", label: "Complete" },
];

const BATCH_CONTROLS: ControlsConfig<BrewBatch> = {
  search: [{ param: "q", accessor: (b) => [b.batch_number, b.beer_name] }],
  filters: [
    { param: "beer", accessor: (b) => b.beer_name },
    { param: "status", accessor: (b) => b.status },
  ],
  sort: {
    columns: [
      { key: "batch_number", accessor: (b) => b.batch_number ?? "" },
      { key: "beer_name", accessor: (b) => b.beer_name },
      { key: "planned_brew_date", accessor: (b) => b.planned_brew_date },
      { key: "expected_delivery_date", accessor: (b) => b.expected_delivery_date ?? "" },
      { key: "volume_bbl", accessor: (b) => b.volume_bbl },
      { key: "status", accessor: (b) => STATUS_SORT_INDEX[b.status] ?? 99 },
    ],
    default: { key: "status", dir: "asc" },
  },
};
```

- [ ] **Step 2: Replace state + filtering/sorting**

Remove `sort` (line ~75), `filterBeer`, `filterStatus` (lines ~76–77), `toggleSort` (lines ~134–136), `STATUS_ORDER` + `sortBatches` (lines ~138–162), and the `filteredBatches`/`allBatches` derivations (lines ~226–232). Replace with:

```tsx
  const { rows: allBatches, search, filters, sort, setSearch, setFilter, toggleSort, reset, activeCount } =
    useTableControls(batches, BATCH_CONTROLS);

  const beerOptions = useMemo(
    () =>
      Array.from(new Set(batches.map((b) => b.beer_name)))
        .sort()
        .map((n) => ({ value: n, label: n })),
    [batches],
  );
```

Keep every downstream consumer of `allBatches` intact.

- [ ] **Step 3: Replace the filter toolbar JSX**

Replace the beer/status `<select>` + Clear block (lines ~238–269) with:

```tsx
      <FilterBar activeCount={activeCount} onClear={reset}>
        <SearchInput
          value={search.q ?? ""}
          onChange={(v) => setSearch("q", v)}
          placeholder="Search batches…"
        />
        <FilterSelect
          label="Beer"
          options={beerOptions}
          value={filters.beer ?? []}
          onChange={(v) => setFilter("beer", v)}
        />
        <FilterChips
          label="Status"
          options={STATUS_OPTIONS}
          value={filters.status ?? []}
          onChange={(v) => setFilter("status", v)}
        />
      </FilterBar>
```

- [ ] **Step 4: Swap the local `SortTh` for `SortableTh`**

Delete the local `SortTh` component (lines ~1191–1205). Thread `sort` (a `SortState`) and `toggleSort` from the hook into `BatchTable` (add them to its props). In `BatchTable`'s thead (lines ~1248–1255), replace each `<SortTh col="…" label="…" />` with:

```tsx
        <SortableTh label="Batch #" sortKey="batch_number" sort={sort} onSort={toggleSort} />
        <SortableTh label="Beer" sortKey="beer_name" sort={sort} onSort={toggleSort} />
        <SortableTh label="Brew Date" sortKey="planned_brew_date" sort={sort} onSort={toggleSort} />
        <SortableTh label="Delivery" sortKey="expected_delivery_date" sort={sort} onSort={toggleSort} />
        <SortableTh label="Volume" sortKey="volume_bbl" sort={sort} onSort={toggleSort} align="right" />
        <SortableTh label="Status" sortKey="status" sort={sort} onSort={toggleSort} />
```

(Match the existing header labels/alignment in the file; keep any non-sortable `<th>`s as-is.)

- [ ] **Step 5: Gate**

Run: `npx tsc --noEmit && npm run build && npm run lint && npm run test`
Then: `npm run check:search-filter` — confirm `BatchLogTab.tsx` (the local `SortTh`) no longer appears.
Expected: clean; BatchLogTab gone from violations.

- [ ] **Step 6: Commit**

```bash
git add app/production/components/BatchLogTab.tsx
git commit -m "$(cat <<'EOF'
refactor(production): Batch Log onto shared search/filter/sort primitives

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Retrofit Export Bay (predicate filters + segmented domain sort)

**Files:**
- Modify: `app/production/components/ExportBayTab.tsx`

**Interfaces:**
- Consumes: `useTableControls` (with `setSort` + `matches`), `SearchInput`, `FilterChips`, `FilterBar`, `ControlsConfig`.
- Produces: nothing downstream.

**Context:** 1237-line client component. The list iterates recipe-id strings (`allRecipeIds`), resolving names via `recipeNameById`/`partnerNameById`, and renders a **card grid per recipe group — there is no sortable table.** Current state (lines ~154–158): `search`, `filterStatus`/`filterChannel`/`filterPartner` (scalar, `"all"` sentinel), `sortBy` (`urgency`/`name`/`stock` — a domain sort). A **local `FilterChips`** (lines ~57–82) renders all four controls. The main pipeline (lines ~277–329) filters recipe ids by: recipe-name substring (search), status bucket (pending/fulfilled/inventory_only), channel present, partner present — each a **predicate over the recipe's allocations** — then sorts via `urgencySort`/`localeCompare`/stock.

**Target:** shared `SearchInput` (recipe name) + shared `FilterChips` for status/channel/partner as **predicate filters** (`matches`), and the sort as a **segmented control** calling `setSort(key, "asc")`. Delete the local `FilterChips`. Channel/partner options stay derived; channel chips carry `CHANNEL_COLOR` classes via `options[].className`. Sort accessors are signed so all three are ascending: `urgency` = earliest-due epoch asc, `name` = recipe name asc, `stock` = negative stock total (asc ⇒ most stock first).

- [ ] **Step 1: Build the config with `useMemo`** (accessors close over the recipe maps)

Add near the top of the component, after the maps (`recipeNameById`, `partnerNameById`, `presentChannels`, etc.) and the helpers (`earliestDueDate`, and a `stockTotal(recipeId)` — reuse the existing stock computation used by the current `stock` sort at lines ~323–327; extract it into a small helper if inline):

```tsx
  const exportControls = useMemo<ControlsConfig<string>>(() => ({
    search: [{ param: "q", accessor: (id) => recipeNameById.get(id) ?? "" }],
    filters: [
      { param: "status",  matches: (id, sel) => sel.some((s) => recipeMatchesStatus(id, s)) },
      { param: "channel", matches: (id, sel) => sel.some((s) => recipeHasChannel(id, s)) },
      { param: "partner", matches: (id, sel) => sel.some((s) => recipeHasPartner(id, s)) },
    ],
    sort: {
      columns: [
        { key: "urgency", accessor: (id) => earliestDueEpoch(id) },
        { key: "name",    accessor: (id) => recipeNameById.get(id) ?? "" },
        { key: "stock",   accessor: (id) => -stockTotal(id) },
      ],
      default: { key: "urgency", dir: "asc" },
    },
  }), [recipeNameById, /* + every map/helper referenced above */]);
```

Define `recipeMatchesStatus(id, s)`, `recipeHasChannel(id, s)`, `recipeHasPartner(id, s)`, and `earliestDueEpoch(id)` by lifting the **existing predicate/sort expressions verbatim** out of the current `.filter(...).sort(...)` pipeline (lines ~287–328): the status-bucket test becomes `recipeMatchesStatus`; the `a.channel === filterChannel` presence test becomes `recipeHasChannel`; the partner-group presence test becomes `recipeHasPartner`; `earliestDueDate(id)` → epoch millis (`Date.parse`, with a large fallback for none so "no due date" sorts last). Do not invent new logic — move what's there.

- [ ] **Step 2: Drive rows + selections through the hook**

Remove `search`, `filterStatus`, `filterChannel`, `filterPartner`, `sortBy` state (lines ~154–158), the `hasFilters`/`isFiltered`/`clearFilters` helpers (lines ~332–340), and the whole `filteredRecipeIds` pipeline (lines ~277–329). Replace with:

```tsx
  const { rows: filteredRecipeIds, search, filters, sort, setSearch, setFilter, setSort, reset, activeCount } =
    useTableControls(allRecipeIds, exportControls);
```

Keep the downstream rendering that maps over `filteredRecipeIds`.

- [ ] **Step 3: Replace controls with shared primitives**

Delete the local `FilterChips` component (lines ~57–82). Build the derived option lists as today (`channelChipOptions` from `presentChannels`, `partnerChipOptions` from `seenPartners`) but shaped as `{ value, label, className? }`; give each channel option its color via `CHANNEL_COLOR`:

```tsx
      <FilterBar activeCount={activeCount} onClear={reset}>
        <SearchInput
          value={search.q ?? ""}
          onChange={(v) => setSearch("q", v)}
          placeholder="Search recipes…"
        />
        <FilterChips
          label="Status"
          options={STATUS_OPTIONS}  /* all/pending/fulfilled/inventory_only minus "all" — [] is All */
          value={filters.status ?? []}
          onChange={(v) => setFilter("status", v)}
        />
        {channelChipOptions.length > 1 && (
          <FilterChips label="Channel" options={channelChipOptions}
            value={filters.channel ?? []} onChange={(v) => setFilter("channel", v)} />
        )}
        {showPartnerChips && (
          <FilterChips label="Partner" options={partnerChipOptions}
            value={filters.partner ?? []} onChange={(v) => setFilter("partner", v)} />
        )}
        {/* segmented domain sort — no table here, so not SortableTh */}
        <FilterChips
          label="Sort"
          options={[
            { value: "urgency", label: "Urgency" },
            { value: "name", label: "A–Z" },
            { value: "stock", label: "Stock" },
          ]}
          value={sort ? [sort.key] : ["urgency"]}
          onChange={(v) => setSort(v[0] ?? "urgency", "asc")}
        />
      </FilterBar>
```

`STATUS_OPTIONS` here = `pending`/`fulfilled`/`inventory_only` (labels "Pending"/"Fulfilled"/"Stock only"); the "All" chip is auto-rendered and clears the dimension. The Sort row reuses `FilterChips` purely as a segmented single-select bound to `setSort` (documented one-off: Export Bay has no column table). Keep `CHANNEL_CHIP_LABELS`/`CHANNEL_COLOR` and the `ChannelBadge`/`KEG_TAG_BADGE` usages elsewhere untouched.

- [ ] **Step 4: Gate**

Run: `npx tsc --noEmit && npm run build && npm run lint && npm run test`
Then: `npm run check:search-filter` — confirm `ExportBayTab.tsx` (local `FilterChips`, `type="search"`, `.toLowerCase().includes`) no longer appears.
Expected: clean; ExportBayTab gone from violations.

- [ ] **Step 5: Commit**

```bash
git add app/production/components/ExportBayTab.tsx
git commit -m "$(cat <<'EOF'
refactor(production): Export Bay onto shared primitives (predicate filters + segmented sort)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Retrofit Ingredients (add field-coded search, migrate category filter)

**Files:**
- Modify: `app/production/components/IngredientsTab.tsx`

**Interfaces:**
- Consumes: `useTableControls`, `SearchInput`, `FilterChips`, `FilterBar`, `ControlsConfig`.
- Produces: nothing downstream.

**Context:** 912-line client component, self-contained. Row type `Ingredient`. One pill filter `filterCat` (`IngredientCategory | "all"`, line ~364) rendered as colored pills (lines ~541–559) from `INGREDIENT_CATEGORIES`; active pill uses `INGREDIENT_CATEGORY_META[cat].color`. Rows are grouped into **per-category tables** (lines ~582–591), with `filterCat` selecting which groups render. **No search, no sort today.** Per-group dynamic columns (`showAlphaAcid = cat==="Hops"`, etc.) and the synthesized "Uncategorized" group must be preserved.

**Target:** add a field-coded ingredient-name search; migrate `filterCat` to the hook as a category `FilterChips` (preserving category colors via `options[].className`). Keep the category grouping and no column sort (grouping is the ordering). URL prefix not needed here alone, but this route hosts three sibling tabs → **use `prefix: "ing_"`**.

- [ ] **Step 1: Config (module scope) + colored options**

```tsx
import { useTableControls } from "@/app/components/ui/useTableControls";
import SearchInput from "@/app/components/ui/SearchInput";
import FilterChips from "@/app/components/ui/FilterChips";
import FilterBar from "@/app/components/ui/FilterBar";
import type { ControlsConfig } from "@/lib/table/types";

const INGREDIENT_CONTROLS: ControlsConfig<Ingredient> = {
  search: [{ param: "q", accessor: (i) => i.name }],
  filters: [{ param: "category", accessor: (i) => i.category ?? "Uncategorized" }],
};

const CATEGORY_OPTIONS = INGREDIENT_CATEGORIES.map((c) => ({
  value: c,
  label: c,
  className: INGREDIENT_CATEGORY_META[c]?.color,  // category color = raw-color exception
}));
```

- [ ] **Step 2: Drive rows through the hook, keep grouping**

Replace `const [filterCat, setFilterCat] = useState<…>("all")` with:

```tsx
  const { rows: visibleIngredients, search, filters, setSearch, setFilter, reset, activeCount } =
    useTableControls(ingredients, INGREDIENT_CONTROLS, { prefix: "ing_" });
```

In the grouping IIFE (lines ~582–591), build groups from `visibleIngredients` instead of `ingredients` (so both the name search and category filter apply). Because the category filter already narrows rows, the existing "render every category group that has items" logic now naturally shows only the selected category (and, when no category is selected, all categories plus the synthesized "Uncategorized" group — unchanged). Keep the per-group dynamic-column logic as-is.

- [ ] **Step 3: Replace the pill row with `FilterBar`**

Replace the category-pill block (lines ~541–559) with:

```tsx
      <FilterBar activeCount={activeCount} onClear={reset}>
        <SearchInput
          value={search.q ?? ""}
          onChange={(v) => setSearch("q", v)}
          placeholder="Search ingredients…"
        />
        <FilterChips
          label="Category"
          options={CATEGORY_OPTIONS}
          value={filters.category ?? []}
          onChange={(v) => setFilter("category", v)}
        />
      </FilterBar>
```

- [ ] **Step 4: Gate**

Run: `npx tsc --noEmit && npm run build && npm run lint && npm run test`
Then: `npm run check:search-filter` (IngredientsTab should not introduce new violations).
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add app/production/components/IngredientsTab.tsx
git commit -m "$(cat <<'EOF'
refactor(production): Ingredients search + category filter onto shared primitives

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Retrofit Packaging (mirror of Ingredients)

**Files:**
- Modify: `app/production/components/PackagingTab.tsx`

**Interfaces:**
- Consumes: `useTableControls`, `SearchInput`, `FilterChips`, `FilterBar`, `ControlsConfig`.
- Produces: nothing downstream.

**Context:** 462-line client component, self-contained. Row type `PackagingItem`. One pill filter `filterType` (`PackagingItemType | "all"`, line ~67) from `TYPES` (`Object.keys(TYPE_META)`), colored via `TYPE_META[t].color`. Rows grouped into **per-type tables** (lines ~180–184, 213–221) with per-group dynamic 6th column. **No search, no sort today.** Same route as Ingredients → **use `prefix: "pkg_"`**.

- [ ] **Step 1: Config + colored options**

```tsx
import { useTableControls } from "@/app/components/ui/useTableControls";
import SearchInput from "@/app/components/ui/SearchInput";
import FilterChips from "@/app/components/ui/FilterChips";
import FilterBar from "@/app/components/ui/FilterBar";
import type { ControlsConfig } from "@/lib/table/types";

const PACKAGING_CONTROLS: ControlsConfig<PackagingItem> = {
  search: [{ param: "q", accessor: (p) => p.name }],
  filters: [{ param: "type", accessor: (p) => p.type }],
};

const TYPE_OPTIONS = TYPES.map((t) => ({
  value: t,
  label: TYPE_META[t].label,
  className: TYPE_META[t].color,
}));
```

- [ ] **Step 2: Drive rows through the hook, keep grouping**

Replace `const [filterType, setFilterType] = useState<…>("all")` with:

```tsx
  const { rows: visiblePackaging, search, filters, setSearch, setFilter, reset, activeCount } =
    useTableControls(packaging, PACKAGING_CONTROLS, { prefix: "pkg_" });
```

Build `grouped` (lines ~180–184) from `visiblePackaging`. Keep the "skip empty groups" render loop and per-type dynamic column logic unchanged.

- [ ] **Step 3: Replace the pill row with `FilterBar`**

Replace the type-pill block (lines ~189–207) with:

```tsx
      <FilterBar activeCount={activeCount} onClear={reset}>
        <SearchInput
          value={search.q ?? ""}
          onChange={(v) => setSearch("q", v)}
          placeholder="Search packaging…"
        />
        <FilterChips
          label="Type"
          options={TYPE_OPTIONS}
          value={filters.type ?? []}
          onChange={(v) => setFilter("type", v)}
        />
      </FilterBar>
```

- [ ] **Step 4: Gate**

Run: `npx tsc --noEmit && npm run build && npm run lint && npm run test`
Then: `npm run check:search-filter`.
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add app/production/components/PackagingTab.tsx
git commit -m "$(cat <<'EOF'
refactor(production): Packaging search + type filter onto shared primitives

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Retrofit Stock Adjustments (single-table search + source filter + sortable Date)

**Files:**
- Modify: `app/production/components/StockAdjustmentsTab.tsx`

**Interfaces:**
- Consumes: `useTableControls`, `SearchInput`, `FilterChips`, `FilterBar`, `SortableTh`, `ControlsConfig`.
- Produces: nothing downstream.

**Context:** 277-line client component. Local row type `Row` (built by `buildRows`), fields incl. `source: "ingredients"|"packaging"`, `itemName`, `createdAt`. Current controls (lines ~131–134 / toolbar ~185–230): `source` (3-pill segmented), `search` (`itemName` `.includes`), `sortDir` (Date toggle), `groupByDate` (view toggle). Filter/sort pipeline lines ~138–144. Single shared `<thead>` (lines ~166–180); when `groupByDate`, multiple day tables. The `groups` memo (lines ~154–164) walks `filtered` in order and depends on date-sorted adjacency. Same route as the other two inventory tabs → **use `prefix: "adj_"`**.

**Target:** search → `SearchInput` (`itemName`, placeholder "Search items…"); source → `FilterChips`; Date sort → `SortableTh` on the Date header (only the Date column is sortable, preserving day-grouping validity). Keep `groupByDate` as local view state. `SOURCE_COLORS` stays for the per-row source badge.

- [ ] **Step 1: Config (module scope)**

```tsx
import { useTableControls } from "@/app/components/ui/useTableControls";
import SearchInput from "@/app/components/ui/SearchInput";
import FilterChips from "@/app/components/ui/FilterChips";
import FilterBar from "@/app/components/ui/FilterBar";
import SortableTh from "@/app/components/ui/SortableTh";
import type { ControlsConfig } from "@/lib/table/types";

const ADJUSTMENT_CONTROLS: ControlsConfig<Row> = {
  search: [{ param: "q", accessor: (r) => r.itemName }],
  filters: [{ param: "source", accessor: (r) => r.source }],
  sort: {
    columns: [{ key: "date", accessor: (r) => r.createdAt }],
    default: { key: "date", dir: "desc" },
  },
};

const SOURCE_OPTIONS = [
  { value: "ingredients", label: "Ingredients" },
  { value: "packaging", label: "Packaging" },
];
```

- [ ] **Step 2: Drive rows through the hook; keep `groupByDate` local**

Replace `source`/`search`/`sortDir` state (lines ~131–133) with the hook; keep `groupByDate` as `useState`:

```tsx
  const { rows: filtered, search, filters, sort, setSearch, setFilter, toggleSort, reset, activeCount } =
    useTableControls(allRows, ADJUSTMENT_CONTROLS, { prefix: "adj_" });
  const [groupByDate, setGroupByDate] = useState(false);
```

Delete the old `.filter().filter().sort()` pipeline (lines ~138–144) — the hook now yields `filtered`. Keep the `groups` memo (lines ~154–164) reading `filtered`; it stays valid because the only sortable column is Date.

- [ ] **Step 3: Replace the toolbar; make Date header sortable**

Replace the source-pills + search + date-sort-toggle block (lines ~187–217) with a `FilterBar` (keep the `groupByDate` and count elements alongside/after it):

```tsx
      <FilterBar activeCount={activeCount} onClear={reset}>
        <SearchInput
          value={search.q ?? ""}
          onChange={(v) => setSearch("q", v)}
          placeholder="Search items…"
        />
        <FilterChips
          label="Source"
          options={SOURCE_OPTIONS}
          value={filters.source ?? []}
          onChange={(v) => setFilter("source", v)}
        />
      </FilterBar>
```

In the shared `<thead>` (lines ~166–180), replace the plain Date `<th>` with:

```tsx
        <SortableTh label="Date" sortKey="date" sort={sort} onSort={toggleSort} />
```

Leave the other `<th>`s unchanged (non-sortable, so day-grouping stays coherent). Keep the group-by-date toggle button and the "{filtered.length} records" count.

- [ ] **Step 4: Gate**

Run: `npx tsc --noEmit && npm run build && npm run lint && npm run test`
Then: `npm run check:search-filter` — confirm `StockAdjustmentsTab.tsx` (`type="search"` on line ~204 was actually `.inp`; the `.toLowerCase().includes` on line ~143) no longer appears.
Expected: clean; StockAdjustmentsTab gone from violations.

- [ ] **Step 5: Commit**

```bash
git add app/production/components/StockAdjustmentsTab.tsx
git commit -m "$(cat <<'EOF'
refactor(production): Stock Adjustments onto shared primitives (sortable Date)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Definition of Done (PR 1)

- [ ] `npm run test` passes; coverage ≥ 86 (Task 1 adds engine tests).
- [ ] `npx tsc --noEmit` clean; `npm run build` succeeds (no `useSearchParams`/Suspense error).
- [ ] `npm run lint` clean.
- [ ] `npm run check:search-filter`: the four originally-flagged files (Batch Log, Export Bay, Taproom Inventory, Stock Adjustments) are **gone** from the WARN list; remaining warns belong to PR 2–4 surfaces only. Record the before/after count.
- [ ] **Browser verification (controller step)** via the preview server for each of the six surfaces: search filters live, categorical chips/dropdown filter, "Clear (N)" resets, sort toggles (Batch Log columns, Stock Adjustments Date, Export Bay segmented), URL updates and a reload restores state, and the Taproom recipe/partner split works. Capture a screenshot per surface.
- [ ] Grouped layouts (Ingredients categories, Packaging types, Stock Adjustments day-groups) still render correctly under filtering.

## Out of scope (later PRs)

- PR 2: rest of production (Shipments, Export Invoices, Packaging Variations, Commitments — migrate off `app/reports/components/SortControls.tsx`, Partners, Mapping Drawer).
- PR 3: finance. PR 4: taproom remainder + delete legacy `SortControls.tsx` + flip guard to `--strict`.
