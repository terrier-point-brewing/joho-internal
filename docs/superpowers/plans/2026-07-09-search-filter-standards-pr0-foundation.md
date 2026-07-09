# Search / Filter / Sort Standards — PR 0 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared search/filter/sort foundation — a pure filter+sort engine, a URL-state serializer, a thin `useTableControls` hook, five presentational primitives, an enforcement grep guard, and the standard doc — with **zero behavior change** to any existing page.

**Architecture:** Pure, node-testable logic lives in `lib/table/` (the only path inside vitest's test + coverage globs). React glue is a thin hook in `app/components/ui/useTableControls.ts` that reads/writes the URL via `next/navigation` and delegates all real work to the pure functions. Presentational primitives in `app/components/ui/` compose token utilities only. This is the "primitives + compose per page" pattern already used by `Badge`/`Card`/`Modal`.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Tailwind v4, React 19, Vitest (node env), `next/navigation`.

## Global Constraints

- **Pure logic in `lib/table/` only.** Vitest `include` is `lib/**/*.test.ts`; coverage `include` is `lib/**/*.ts`. Anything under `app/components/ui/` is **not** unit-tested here (node env, no DOM) — verify those via `tsc` + `build`.
- **Coverage floor:** `vitest.config.ts` requires lines ≥ 86, statements ≥ 86. New `lib/table/*.ts` files must be thoroughly tested. `lib/table/types.ts` is exempt (config excludes `lib/**/types.ts`).
- **No raw colors** in feature/UI code — use token utilities only (`bg-surface-*`, `border-line-*`, `text-*`, `text-accent*`). No `zinc-*`/`amber-*`/`red-*`/`green-*`/`blue-*`/`gray-*` or hex/rgb. See `docs/UI_STANDARD.md`.
- **No hand-rolled primitives** — inputs use `.inp`/`.inp-sm`, buttons use `.btn-ghost`/`.btn-xs`.
- **Zero behavior change** to existing pages in PR 0. Do not modify any feature component. The one exception permitted here: none — retrofits are PR 1+.
- **Enforcement guard is warn-only in PR 0** (exits 0). It flips to blocking in PR 4.
- **Square/Supabase versions, auth, etc.** unchanged — this PR touches no API routes or data layer.
- **Commit message trailer:** end every commit body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

New files:
- `lib/table/types.ts` — shared types (`SortDir`, `SortState`, `ControlsConfig`, `ControlsState`, spec interfaces). Coverage-exempt.
- `lib/table/applyControls.ts` — pure filter + sort engine.
- `lib/table/applyControls.test.ts` — engine tests.
- `lib/table/urlState.ts` — pure `ControlsState` ↔ `URLSearchParams` serialize/parse + `countActiveControls`.
- `lib/table/urlState.test.ts` — url-state tests.
- `app/components/ui/useTableControls.ts` — thin client hook (URL-synced state; delegates to the pure fns).
- `app/components/ui/SearchInput.tsx` — debounced, field-labeled text box.
- `app/components/ui/FilterChips.tsx` — segmented chip control (single/multi).
- `app/components/ui/FilterSelect.tsx` — categorical dropdown.
- `app/components/ui/FilterBar.tsx` — layout container + "Clear (N)" button.
- `app/components/ui/SortableTh.tsx` — sortable `<th>` (unifies the two existing `SortTh`s).
- `scripts/check-search-filter.mjs` — enforcement grep guard.

Modified files:
- `package.json` — add `check:search-filter` script.
- `.github/workflows/ci.yml` — add a warn-only guard step.
- `docs/UI_STANDARD.md` — add the Search / Filter / Sort section.

**Note:** `app/reports/components/SortControls.tsx` is **not** deleted in PR 0. Its one consumer (`CommitmentsTab`) migrates in PR 2; the file is removed in PR 4. `SortableTh` is the new canonical home going forward.

---

### Task 1: Filter + sort engine (`lib/table/applyControls.ts`)

**Files:**
- Create: `lib/table/types.ts`
- Create: `lib/table/applyControls.ts`
- Test: `lib/table/applyControls.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `type SortDir = "asc" | "desc"`
  - `type SortState = { key: string; dir: SortDir } | null`
  - `interface SearchSpec<T> { param: string; accessor: (row: T) => string | (string | null | undefined)[] }`
  - `interface FilterSpec<T> { param: string; accessor: (row: T) => string; multi?: boolean }`
  - `interface SortSpec<T> { key: string; accessor: (row: T) => unknown }`
  - `interface ControlsConfig<T> { search?: SearchSpec<T>[]; filters?: FilterSpec<T>[]; sort?: { columns: SortSpec<T>[]; default?: SortState } }`
  - `interface ControlsState { search: Record<string, string>; filters: Record<string, string[]>; sort: SortState }`
  - `function applyControls<T>(rows: T[], config: ControlsConfig<T>, state: ControlsState): T[]`

**Semantics (contract the tests pin down):**
- Search: each box AND-combined across boxes; within one box, OR across its accessor field(s); case-insensitive substring; empty/whitespace query = no filtering.
- Filters: each dimension AND-combined; within one dimension, OR across selected values; an empty `string[]` (or missing param) = "All" = no filtering.
- Sort: single active column found by `key`; `coerce` numbers first (parse numeric strings), else `localeCompare`; `null`/`undefined` coerce to `""`; sort is stable-enough via a fresh array copy; `sort: null` or unknown key = original order.

- [ ] **Step 1: Write the types file**

Create `lib/table/types.ts`:

```ts
export type SortDir = "asc" | "desc";

/** null = no active sort (fall back to the config default or source order). */
export type SortState = { key: string; dir: SortDir } | null;

/** One free-text search box. An accessor returning an array = identity-blend
 *  (OR across those fields within this single box). */
export interface SearchSpec<T> {
  /** URL param key, e.g. "q" or "q_recipe". */
  param: string;
  accessor: (row: T) => string | (string | null | undefined)[];
}

/** One categorical filter dimension. */
export interface FilterSpec<T> {
  /** URL param key, e.g. "status" or "channel". */
  param: string;
  accessor: (row: T) => string;
  /** true = multiple values may be selected (OR within the dimension). */
  multi?: boolean;
}

/** One sortable column. */
export interface SortSpec<T> {
  /** Sort key, matches SortState.key and the `sort` URL param value. */
  key: string;
  accessor: (row: T) => unknown;
}

export interface ControlsConfig<T> {
  search?: SearchSpec<T>[];
  filters?: FilterSpec<T>[];
  sort?: { columns: SortSpec<T>[]; default?: SortState };
}

export interface ControlsState {
  /** param -> query text. */
  search: Record<string, string>;
  /** param -> selected values. Empty array = no filter (All). */
  filters: Record<string, string[]>;
  sort: SortState;
}
```

- [ ] **Step 2: Write the failing test**

Create `lib/table/applyControls.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { applyControls } from "./applyControls";
import type { ControlsConfig, ControlsState } from "./types";

interface Row {
  recipe: string;
  partner: string | null;
  status: string;
  volume: number;
}

const ROWS: Row[] = [
  { recipe: "Hazy IPA", partner: "Acme", status: "open", volume: 10 },
  { recipe: "Stout", partner: "Beta Co", status: "closed", volume: 2 },
  { recipe: "Pilsner", partner: null, status: "open", volume: 30 },
];

const CONFIG: ControlsConfig<Row> = {
  search: [
    { param: "q", accessor: (r) => r.recipe },
    { param: "q_blend", accessor: (r) => [r.recipe, r.partner] },
  ],
  filters: [
    { param: "status", accessor: (r) => r.status },
    { param: "partner", accessor: (r) => r.partner ?? "", multi: true },
  ],
  sort: { columns: [{ key: "volume", accessor: (r) => r.volume }, { key: "recipe", accessor: (r) => r.recipe }] },
};

const EMPTY: ControlsState = { search: {}, filters: {}, sort: null };

describe("applyControls", () => {
  it("returns all rows when state is empty", () => {
    expect(applyControls(ROWS, CONFIG, EMPTY)).toHaveLength(3);
  });

  it("text search is case-insensitive substring on the coded field", () => {
    const out = applyControls(ROWS, CONFIG, { ...EMPTY, search: { q: "ipa" } });
    expect(out.map((r) => r.recipe)).toEqual(["Hazy IPA"]);
  });

  it("blank / whitespace query does not filter", () => {
    expect(applyControls(ROWS, CONFIG, { ...EMPTY, search: { q: "   " } })).toHaveLength(3);
  });

  it("identity-blend search ORs across the box's fields", () => {
    const out = applyControls(ROWS, CONFIG, { ...EMPTY, search: { q_blend: "beta" } });
    expect(out.map((r) => r.recipe)).toEqual(["Stout"]); // matched on partner
  });

  it("categorical filter keeps only matching rows", () => {
    const out = applyControls(ROWS, CONFIG, { ...EMPTY, filters: { status: ["open"] } });
    expect(out.map((r) => r.recipe)).toEqual(["Hazy IPA", "Pilsner"]);
  });

  it("empty filter array = All (no filtering)", () => {
    expect(applyControls(ROWS, CONFIG, { ...EMPTY, filters: { status: [] } })).toHaveLength(3);
  });

  it("multi-select filter ORs across selected values", () => {
    const out = applyControls(ROWS, CONFIG, { ...EMPTY, filters: { partner: ["Acme", "Beta Co"] } });
    expect(out.map((r) => r.recipe)).toEqual(["Hazy IPA", "Stout"]);
  });

  it("search and filter combine with AND", () => {
    const out = applyControls(ROWS, CONFIG, { ...EMPTY, search: { q: "s" }, filters: { status: ["open"] } });
    expect(out.map((r) => r.recipe)).toEqual(["Pilsner"]); // Pilsner matches 's' and open
  });

  it("sorts numbers ascending and descending", () => {
    const asc = applyControls(ROWS, CONFIG, { ...EMPTY, sort: { key: "volume", dir: "asc" } });
    expect(asc.map((r) => r.volume)).toEqual([2, 10, 30]);
    const desc = applyControls(ROWS, CONFIG, { ...EMPTY, sort: { key: "volume", dir: "desc" } });
    expect(desc.map((r) => r.volume)).toEqual([30, 10, 2]);
  });

  it("sorts strings via localeCompare", () => {
    const out = applyControls(ROWS, CONFIG, { ...EMPTY, sort: { key: "recipe", dir: "asc" } });
    expect(out.map((r) => r.recipe)).toEqual(["Hazy IPA", "Pilsner", "Stout"]);
  });

  it("unknown sort key leaves order unchanged", () => {
    const out = applyControls(ROWS, CONFIG, { ...EMPTY, sort: { key: "nope", dir: "asc" } });
    expect(out.map((r) => r.recipe)).toEqual(["Hazy IPA", "Stout", "Pilsner"]);
  });

  it("does not mutate the input array", () => {
    const copy = [...ROWS];
    applyControls(ROWS, CONFIG, { ...EMPTY, sort: { key: "volume", dir: "desc" } });
    expect(ROWS).toEqual(copy);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -- applyControls`
Expected: FAIL — `applyControls` not exported / module not found.

- [ ] **Step 4: Write the engine**

Create `lib/table/applyControls.ts`:

```ts
import type { ControlsConfig, ControlsState } from "./types";

/** Coerce a value to a comparable primitive (number takes priority). */
function coerce(v: unknown): number | string {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return isNaN(n) ? v.toLowerCase() : n;
  }
  return String(v ?? "").toLowerCase();
}

function compare(a: unknown, b: unknown): number {
  const av = coerce(a);
  const bv = coerce(b);
  if (typeof av === "number" && typeof bv === "number") return av - bv;
  return String(av).localeCompare(String(bv));
}

/** Apply search boxes, categorical filters, and a single sort column to `rows`.
 *  Pure — never mutates the input. See applyControls.test.ts for the contract. */
export function applyControls<T>(
  rows: T[],
  config: ControlsConfig<T>,
  state: ControlsState,
): T[] {
  let out = rows;

  for (const spec of config.search ?? []) {
    const q = (state.search[spec.param] ?? "").trim().toLowerCase();
    if (!q) continue;
    out = out.filter((row) => {
      const raw = spec.accessor(row);
      const fields = Array.isArray(raw) ? raw : [raw];
      return fields.some((f) => (f ?? "").toString().toLowerCase().includes(q));
    });
  }

  for (const spec of config.filters ?? []) {
    const selected = state.filters[spec.param] ?? [];
    if (selected.length === 0) continue;
    out = out.filter((row) => selected.includes(spec.accessor(row)));
  }

  if (state.sort && config.sort) {
    const col = config.sort.columns.find((c) => c.key === state.sort!.key);
    if (col) {
      const dir = state.sort.dir === "asc" ? 1 : -1;
      out = [...out].sort((a, b) => compare(col.accessor(a), col.accessor(b)) * dir);
    }
  }

  return out;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- applyControls`
Expected: PASS (12 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/table/types.ts lib/table/applyControls.ts lib/table/applyControls.test.ts
git commit -m "$(cat <<'EOF'
feat(table): pure search/filter/sort engine

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: URL-state serialization (`lib/table/urlState.ts`)

**Files:**
- Create: `lib/table/urlState.ts`
- Test: `lib/table/urlState.test.ts`

**Interfaces:**
- Consumes: `ControlsConfig`, `ControlsState`, `SortState` from `lib/table/types.ts`.
- Produces:
  - `function parseControlsState<T>(params: URLSearchParams, config: ControlsConfig<T>, prefix?: string): ControlsState`
  - `function serializeControlsState<T>(state: ControlsState, config: ControlsConfig<T>, base: URLSearchParams, prefix?: string): URLSearchParams`
  - `function countActiveControls(state: ControlsState): number`

**Conventions:**
- Param key = `` `${prefix}${spec.param}` `` (prefix defaults to `""`; used for multi-table pages).
- Search: value is the raw query text; omitted when empty.
- Filter: value is comma-joined selected values (`open,closed`); omitted when empty.
- Sort: single param `` `${prefix}sort` `` = `key` (asc) or `-key` (desc); omitted when `null`.
- `parseControlsState` falls back to `config.sort?.default ?? null` when the sort param is absent.
- `serializeControlsState` clones `base` and only touches the params it owns (preserves unrelated query params).
- `countActiveControls` = number of non-empty search boxes + number of non-empty filter dimensions (sort is not counted).

- [ ] **Step 1: Write the failing test**

Create `lib/table/urlState.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseControlsState, serializeControlsState, countActiveControls } from "./urlState";
import type { ControlsConfig, ControlsState } from "./types";

interface Row { recipe: string; status: string; volume: number }

const CONFIG: ControlsConfig<Row> = {
  search: [{ param: "q", accessor: (r) => r.recipe }],
  filters: [
    { param: "status", accessor: (r) => r.status },
    { param: "channel", accessor: (r) => r.status, multi: true },
  ],
  sort: {
    columns: [{ key: "volume", accessor: (r) => r.volume }],
    default: { key: "volume", dir: "desc" },
  },
};

describe("parseControlsState", () => {
  it("reads search, filters (comma-split), and sort from params", () => {
    const p = new URLSearchParams("q=hazy&status=open&channel=a,b&sort=-volume");
    const s = parseControlsState(p, CONFIG);
    expect(s.search).toEqual({ q: "hazy" });
    expect(s.filters).toEqual({ status: ["open"], channel: ["a", "b"] });
    expect(s.sort).toEqual({ key: "volume", dir: "desc" });
  });

  it("ascending sort has no leading dash", () => {
    const s = parseControlsState(new URLSearchParams("sort=volume"), CONFIG);
    expect(s.sort).toEqual({ key: "volume", dir: "asc" });
  });

  it("falls back to the default sort when the param is absent", () => {
    const s = parseControlsState(new URLSearchParams(""), CONFIG);
    expect(s.sort).toEqual({ key: "volume", dir: "desc" });
    expect(s.search).toEqual({});
    expect(s.filters).toEqual({});
  });

  it("honors a namespace prefix", () => {
    const s = parseControlsState(new URLSearchParams("t1_q=x&t1_status=open"), CONFIG, "t1_");
    expect(s.search).toEqual({ q: "x" });
    expect(s.filters).toEqual({ status: ["open"] });
  });
});

describe("serializeControlsState", () => {
  it("writes only non-empty controls and preserves unrelated params", () => {
    const state: ControlsState = {
      search: { q: "hazy" },
      filters: { status: ["open"], channel: [] },
      sort: { key: "volume", dir: "asc" },
    };
    const base = new URLSearchParams("tab=export");
    const out = serializeControlsState(state, CONFIG, base);
    expect(out.get("tab")).toBe("export");
    expect(out.get("q")).toBe("hazy");
    expect(out.get("status")).toBe("open");
    expect(out.has("channel")).toBe(false);
    expect(out.get("sort")).toBe("volume");
  });

  it("clears a param that became empty", () => {
    const base = new URLSearchParams("q=old&status=open");
    const state: ControlsState = { search: { q: "" }, filters: { status: [] }, sort: null };
    const out = serializeControlsState(state, CONFIG, base);
    expect(out.has("q")).toBe(false);
    expect(out.has("status")).toBe(false);
    expect(out.has("sort")).toBe(false);
  });

  it("round-trips through parse", () => {
    const state: ControlsState = {
      search: { q: "stout" },
      filters: { status: ["closed"], channel: ["a", "b"] },
      sort: { key: "volume", dir: "desc" },
    };
    const sp = serializeControlsState(state, CONFIG, new URLSearchParams());
    expect(parseControlsState(sp, CONFIG)).toEqual(state);
  });
});

describe("countActiveControls", () => {
  it("counts non-empty searches and filter dimensions, ignoring sort", () => {
    expect(countActiveControls({ search: { q: "x" }, filters: { status: ["open"], channel: [] }, sort: { key: "volume", dir: "asc" } })).toBe(2);
    expect(countActiveControls({ search: { q: "" }, filters: {}, sort: null })).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- urlState`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the serializer**

Create `lib/table/urlState.ts`:

```ts
import type { ControlsConfig, ControlsState, SortState } from "./types";

function parseSort(raw: string | null, fallback: SortState): SortState {
  if (!raw) return fallback;
  return raw.startsWith("-")
    ? { key: raw.slice(1), dir: "desc" }
    : { key: raw, dir: "asc" };
}

/** Read a ControlsState out of URL params, given the table's config. */
export function parseControlsState<T>(
  params: URLSearchParams,
  config: ControlsConfig<T>,
  prefix = "",
): ControlsState {
  const search: Record<string, string> = {};
  for (const spec of config.search ?? []) {
    const v = params.get(prefix + spec.param);
    if (v) search[spec.param] = v;
  }

  const filters: Record<string, string[]> = {};
  for (const spec of config.filters ?? []) {
    const v = params.get(prefix + spec.param);
    if (v) filters[spec.param] = v.split(",").filter(Boolean);
  }

  const sort = parseSort(params.get(prefix + "sort"), config.sort?.default ?? null);

  return { search, filters, sort };
}

/** Serialize a ControlsState onto a clone of `base`, touching only owned params. */
export function serializeControlsState<T>(
  state: ControlsState,
  config: ControlsConfig<T>,
  base: URLSearchParams,
  prefix = "",
): URLSearchParams {
  const out = new URLSearchParams(base.toString());

  for (const spec of config.search ?? []) {
    const key = prefix + spec.param;
    const v = (state.search[spec.param] ?? "").trim();
    if (v) out.set(key, v);
    else out.delete(key);
  }

  for (const spec of config.filters ?? []) {
    const key = prefix + spec.param;
    const v = state.filters[spec.param] ?? [];
    if (v.length) out.set(key, v.join(","));
    else out.delete(key);
  }

  const sortKey = prefix + "sort";
  if (state.sort) out.set(sortKey, (state.sort.dir === "desc" ? "-" : "") + state.sort.key);
  else out.delete(sortKey);

  return out;
}

/** Count active search boxes + filter dimensions (drives the "Clear (N)" button). */
export function countActiveControls(state: ControlsState): number {
  const searches = Object.values(state.search).filter((v) => v.trim().length > 0).length;
  const filters = Object.values(state.filters).filter((v) => v.length > 0).length;
  return searches + filters;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- urlState`
Expected: PASS (8 tests).

- [ ] **Step 5: Run full suite + coverage gate**

Run: `npm run test`
Expected: All tests pass; coverage summary still ≥ 86 lines/statements (the two new fully-tested files raise, not lower, the average).

- [ ] **Step 6: Commit**

```bash
git add lib/table/urlState.ts lib/table/urlState.test.ts
git commit -m "$(cat <<'EOF'
feat(table): URL <-> controls-state serialization

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `useTableControls` hook

**Files:**
- Create: `app/components/ui/useTableControls.ts`

**Interfaces:**
- Consumes: `applyControls` (Task 1), `parseControlsState`/`serializeControlsState`/`countActiveControls` (Task 2), types (Task 1).
- Produces:
  - `function useTableControls<T>(rows: T[], config: ControlsConfig<T>, opts?: { prefix?: string }): TableControls<T>`
  - `interface TableControls<T> { rows: T[]; search: Record<string,string>; filters: Record<string,string[]>; sort: SortState; setSearch(param: string, value: string): void; setFilter(param: string, values: string[]): void; toggleSort(key: string): void; reset(): void; activeCount: number }`

**Notes:** Not unit-tested here (no DOM env). Verified via `tsc` + `build` in this task and exercised in-browser during PR 1 retrofits. The hook is deliberately thin: all logic lives in the Task 1/2 pure functions.

- [ ] **Step 1: Write the hook**

Create `app/components/ui/useTableControls.ts`:

```ts
"use client";

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { applyControls } from "@/lib/table/applyControls";
import {
  parseControlsState,
  serializeControlsState,
  countActiveControls,
} from "@/lib/table/urlState";
import type { ControlsConfig, ControlsState, SortDir, SortState } from "@/lib/table/types";

export interface TableControls<T> {
  /** rows after search + filter + sort */
  rows: T[];
  search: Record<string, string>;
  filters: Record<string, string[]>;
  sort: SortState;
  setSearch: (param: string, value: string) => void;
  setFilter: (param: string, values: string[]) => void;
  /** toggle a column: inactive -> asc, asc -> desc, desc -> asc */
  toggleSort: (key: string) => void;
  reset: () => void;
  activeCount: number;
}

/**
 * URL-synced search/filter/sort state for a table. All derivation is delegated
 * to the pure functions in lib/table; this hook only bridges them to the URL.
 */
export function useTableControls<T>(
  rows: T[],
  config: ControlsConfig<T>,
  opts?: { prefix?: string },
): TableControls<T> {
  const prefix = opts?.prefix ?? "";
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const state = useMemo<ControlsState>(
    () => parseControlsState(new URLSearchParams(searchParams.toString()), config, prefix),
    [searchParams, config, prefix],
  );

  const push = useCallback(
    (next: ControlsState) => {
      const base = new URLSearchParams(searchParams.toString());
      const sp = serializeControlsState(next, config, base, prefix);
      const qs = sp.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams, config, prefix],
  );

  const setSearch = useCallback(
    (param: string, value: string) => push({ ...state, search: { ...state.search, [param]: value } }),
    [push, state],
  );

  const setFilter = useCallback(
    (param: string, values: string[]) => push({ ...state, filters: { ...state.filters, [param]: values } }),
    [push, state],
  );

  const toggleSort = useCallback(
    (key: string) => {
      const dir: SortDir = state.sort?.key === key && state.sort.dir === "asc" ? "desc" : "asc";
      push({ ...state, sort: { key, dir } });
    },
    [push, state],
  );

  const reset = useCallback(
    () => push({ search: {}, filters: {}, sort: config.sort?.default ?? null }),
    [push, config],
  );

  const applied = useMemo(() => applyControls(rows, config, state), [rows, config, state]);
  const activeCount = countActiveControls(state);

  return {
    rows: applied,
    search: state.search,
    filters: state.filters,
    sort: state.sort,
    setSearch,
    setFilter,
    toggleSort,
    reset,
    activeCount,
  };
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/components/ui/useTableControls.ts
git commit -m "$(cat <<'EOF'
feat(table): useTableControls hook (URL-synced)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Presentational primitives

**Files:**
- Create: `app/components/ui/SortableTh.tsx`
- Create: `app/components/ui/SearchInput.tsx`
- Create: `app/components/ui/FilterChips.tsx`
- Create: `app/components/ui/FilterSelect.tsx`
- Create: `app/components/ui/FilterBar.tsx`

**Interfaces:**
- Consumes: `SortState` from `lib/table/types.ts`.
- Produces (all default exports unless noted):
  - `SortableTh({ label, sortKey, sort, onSort, align?, className? })`
  - `SearchInput({ value, onChange, placeholder, debounceMs?, className?, ariaLabel? })`
  - `FilterChips({ label, options, value, onChange, multiple?, allLabel?, className? })` — `value: string[]`, `options: { value: string; label: string }[]`
  - `FilterSelect({ label, options, value, onChange, allLabel?, className? })` — `value: string[]` (length 0 or 1)
  - `FilterBar({ children, activeCount?, onClear?, className? })`

**Notes:** No unit tests (no DOM env). Gate = `tsc` + `build`. Token utilities only — no raw colors. These replace the inline `FilterChips` in `ExportBayTab.tsx` and both `SortTh` definitions (in `app/reports/components/SortControls.tsx` and `BatchLogTab.tsx`) going forward.

- [ ] **Step 1: Write `SortableTh.tsx`**

```tsx
import type { SortState } from "@/lib/table/types";

/**
 * Sortable table header cell. Unifies the two prior `SortTh` implementations.
 * Shows ↑ / ↓ when active, ↕ when inactive.
 */
export default function SortableTh({
  label,
  sortKey,
  sort,
  onSort,
  align = "left",
  className = "",
}: {
  label: string;
  sortKey: string;
  sort: SortState;
  onSort: (key: string) => void;
  align?: "left" | "right";
  className?: string;
}) {
  const active = sort?.key === sortKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      className={`px-4 py-3 font-medium text-body cursor-pointer select-none whitespace-nowrap hover:text-primary transition-colors text-${align} ${className}`.trim()}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span className={`text-xs ${active ? "text-accent" : "text-faint"}`}>
          {active ? (sort!.dir === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </span>
    </th>
  );
}
```

- [ ] **Step 2: Write `SearchInput.tsx`**

```tsx
"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Debounced, field-scoped search box. The placeholder MUST name the field(s)
 * it searches (e.g. "Search recipes…") per the search/filter standard.
 */
export default function SearchInput({
  value,
  onChange,
  placeholder,
  debounceMs = 200,
  className = "",
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  debounceMs?: number;
  className?: string;
  ariaLabel?: string;
}) {
  const [text, setText] = useState(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // keep local text in sync when the controlled value changes externally (e.g. reset)
  useEffect(() => {
    setText(value);
  }, [value]);

  useEffect(() => {
    if (text === value) return;
    const id = setTimeout(() => onChangeRef.current(text), debounceMs);
    return () => clearTimeout(id);
  }, [text, value, debounceMs]);

  return (
    <input
      type="search"
      value={text}
      onChange={(e) => setText(e.target.value)}
      placeholder={placeholder}
      aria-label={ariaLabel ?? placeholder}
      className={`inp-sm max-w-xs ${className}`.trim()}
    />
  );
}
```

> **Enforcement note:** `SearchInput.tsx` is the *one* sanctioned `type="search"` input. The grep guard (Task 5) excludes `app/components/ui/`.

- [ ] **Step 3: Write `FilterChips.tsx`**

```tsx
"use client";

/**
 * Segmented chip filter. Single-select by default; `multiple` toggles membership.
 * `value` is the selected values ([] = All). Promoted from the inline Export Bay
 * version. For data-category dimensions (channel, etc.) pass category color
 * classes via `options[].className` — those are the sanctioned raw-color exception.
 */
export default function FilterChips({
  label,
  options,
  value,
  onChange,
  multiple = false,
  allLabel = "All",
  className = "",
}: {
  label: string;
  options: { value: string; label: string; className?: string }[];
  value: string[];
  onChange: (v: string[]) => void;
  multiple?: boolean;
  allLabel?: string;
  className?: string;
}) {
  const isAll = value.length === 0;

  function pick(v: string) {
    if (!multiple) {
      onChange([v]);
      return;
    }
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  }

  const chip = (selected: boolean, extra = "") =>
    `text-[11px] px-2 py-0.5 rounded border transition-colors ${
      selected
        ? "border-accent-border bg-accent-muted/40 text-accent-soft"
        : "border-line-strong text-secondary hover:border-line-subtle hover:text-body"
    } ${extra}`.trim();

  return (
    <div className={`flex items-center gap-1.5 flex-wrap ${className}`.trim()}>
      <span className="text-xs text-muted mr-0.5">{label}:</span>
      <button type="button" onClick={() => onChange([])} className={chip(isAll)}>
        {allLabel}
      </button>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => pick(o.value)}
          className={chip(value.includes(o.value), o.className ?? "")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Write `FilterSelect.tsx`**

```tsx
"use client";

/**
 * Categorical dropdown filter (single-select). Use when a dimension has more
 * than ~5 options or space is tight; otherwise prefer FilterChips.
 * `value` is [] (All) or a single-element array.
 */
export default function FilterSelect({
  label,
  options,
  value,
  onChange,
  allLabel = "All",
  className = "",
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string[];
  onChange: (v: string[]) => void;
  allLabel?: string;
  className?: string;
}) {
  return (
    <label className={`inline-flex items-center gap-1.5 ${className}`.trim()}>
      <span className="text-xs text-muted">{label}:</span>
      <select
        value={value[0] ?? ""}
        onChange={(e) => onChange(e.target.value ? [e.target.value] : [])}
        className="inp-sm w-auto"
      >
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
```

- [ ] **Step 5: Write `FilterBar.tsx`**

```tsx
import type { ReactNode } from "react";

/**
 * Layout container for a table's controls. Pages compose SearchInput /
 * FilterChips / FilterSelect (and domain selectors like YearSelect) as children.
 * Renders a "Clear (N)" button when activeCount > 0 and onClear is provided.
 */
export default function FilterBar({
  children,
  activeCount = 0,
  onClear,
  className = "",
}: {
  children: ReactNode;
  activeCount?: number;
  onClear?: () => void;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-3 flex-wrap ${className}`.trim()}>
      {children}
      {onClear && activeCount > 0 && (
        <button type="button" onClick={onClear} className="btn-ghost btn-xs">
          Clear ({activeCount})
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Type-check and build**

Run: `npx tsc --noEmit && npm run build`
Expected: no type errors; build succeeds.

- [ ] **Step 7: Commit**

```bash
git add app/components/ui/SortableTh.tsx app/components/ui/SearchInput.tsx app/components/ui/FilterChips.tsx app/components/ui/FilterSelect.tsx app/components/ui/FilterBar.tsx
git commit -m "$(cat <<'EOF'
feat(ui): search/filter/sort presentational primitives

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Enforcement grep guard

**Files:**
- Create: `scripts/check-search-filter.mjs`
- Modify: `package.json` (add `check:search-filter` script)
- Modify: `.github/workflows/ci.yml` (add a warn-only step)

**Interfaces:**
- Consumes: nothing (standalone Node script; no deps beyond `node:fs`/`node:path`).
- Produces: a CLI that scans `app/**` feature components (excluding `app/components/ui/`) and prints violations. Exits `0` by default (warn-only); exits `1` only with `--strict` (reserved for PR 4).

**What it flags:**
- Raw `type="search"` inputs outside `app/components/ui/`.
- Inline `.toLowerCase().includes(` filter logic in feature components.
- Local redefinitions: `function SortTh`, `const FilterChips`, `function FilterChips`.

- [ ] **Step 1: Write the script**

Create `scripts/check-search-filter.mjs`:

```js
#!/usr/bin/env node
// Search/filter/sort standard guard. Warn-only unless --strict.
// See docs/UI_STANDARD.md and docs/superpowers/specs/2026-07-09-search-filter-standards-design.md
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SCAN_DIR = join(ROOT, "app");
const EXCLUDE = [join("app", "components", "ui")]; // the sanctioned home for primitives
const STRICT = process.argv.includes("--strict");

const RULES = [
  { re: /type=["']search["']/, msg: 'raw <input type="search"> — use <SearchInput> from app/components/ui' },
  { re: /\.toLowerCase\(\)\.includes\(/, msg: "inline .toLowerCase().includes() filter — use useTableControls/applyControls" },
  { re: /function\s+SortTh\b/, msg: "local SortTh — use <SortableTh> from app/components/ui" },
  { re: /(?:function|const)\s+FilterChips\b/, msg: "local FilterChips — use <FilterChips> from app/components/ui" },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(ROOT, full);
    if (EXCLUDE.some((e) => rel.startsWith(e))) continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(full);
  }
  return out;
}

const violations = [];
for (const file of walk(SCAN_DIR)) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        violations.push({ file: relative(ROOT, file), line: i + 1, msg: rule.msg });
      }
    }
  });
}

if (violations.length === 0) {
  console.log("✓ search/filter/sort standard: no violations");
  process.exit(0);
}

const tag = STRICT ? "ERROR" : "WARN";
for (const v of violations) {
  console.log(`${tag} ${v.file}:${v.line} — ${v.msg}`);
}
console.log(`\n${violations.length} violation(s). ${STRICT ? "Failing (strict)." : "Warn-only during the retrofit sweep (PR 1–4)."}`);
process.exit(STRICT ? 1 : 0);
```

- [ ] **Step 2: Add the npm script**

In `package.json`, add to `"scripts"` (after `"test"`):

```json
    "check:search-filter": "node scripts/check-search-filter.mjs"
```

- [ ] **Step 3: Run the guard (expect warnings, exit 0)**

Run: `npm run check:search-filter`
Expected: prints `WARN …` lines for the known pre-retrofit offenders (Export Bay, Batch Log, Taproom Inventory, etc.) and exits **0**. Confirm exit code:
Run: `npm run check:search-filter; echo "exit=$?"`
Expected: ends with `exit=0`.

- [ ] **Step 4: Add the warn-only CI step**

In `.github/workflows/ci.yml`, add a step after the `Test` step and before `Build`:

```yaml
      - name: Search/filter standard (warn-only)
        run: npm run check:search-filter
```

(No `--strict` — this stays warn-only until PR 4 flips it.)

- [ ] **Step 5: Commit**

```bash
git add scripts/check-search-filter.mjs package.json .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
chore(ci): warn-only search/filter standard guard

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Documentation — `docs/UI_STANDARD.md`

**Files:**
- Modify: `docs/UI_STANDARD.md` (append a new section)

**Interfaces:** none (docs only).

- [ ] **Step 1: Append the standard section**

Add this section to the end of `docs/UI_STANDARD.md`:

```markdown
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

**Data-category colors** (channels, urgency ramps) remain the sanctioned
raw-color exception — pass category color classes via `FilterChips`
`options[].className`; do not token-swap them.

**Enforcement:** `npm run check:search-filter` (CI, warn-only during the PR 1–4
retrofit sweep; blocking afterward) flags raw search inputs, inline
`.toLowerCase().includes()`, and local `SortTh`/`FilterChips` in feature code.
```

- [ ] **Step 2: Commit**

```bash
git add docs/UI_STANDARD.md
git commit -m "$(cat <<'EOF'
docs(ui): search/filter/sort standard section

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Definition of Done (PR 0)

- [ ] `npm run test` passes; coverage ≥ 86 lines/statements (unchanged or higher).
- [ ] `npx tsc --noEmit` clean.
- [ ] `npm run build` succeeds.
- [ ] `npm run check:search-filter` runs, prints the known pre-retrofit WARN lines, exits 0.
- [ ] `npm run lint` clean.
- [ ] No existing feature component modified — behavior of every current page is byte-for-byte unchanged.
- [ ] Design spec's PR-0 file list fully created; `docs/UI_STANDARD.md` section added.

## Out of scope (later PRs)

- PR 1: retrofit Batch Log, Export Bay, Production Inventory, Taproom Inventory.
- PR 2: rest of production (incl. migrating `CommitmentsTab` off `app/reports/components/SortControls.tsx`).
- PR 3: finance.
- PR 4: taproom remainder, delete `app/reports/components/SortControls.tsx`, flip guard to `--strict`.
```
