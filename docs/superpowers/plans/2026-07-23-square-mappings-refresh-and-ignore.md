# Square Item Mappings — Refresh & Ignore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual "Refresh from Square" button, auto-recompute suggestions on every page load, and an "ignore this mapping" capability to the Square item-mappings grid.

**Architecture:** Suggestions stay server-computed on every grid fetch. A new `recipe_square_link_ignores` table (same cell grain as links) records ignored cells; `buildGrid` nulls their suggestion so they drop out of counts/auto-fill/warning automatically. The refresh button reuses the existing `POST /api/finance/sync-catalog`. Load-freshness comes from a per-query `refetchOnMount: "always"`.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase Postgres, @tanstack/react-query, Tailwind v4 (token utilities), vitest.

## Global Constraints

- Execution mode: **inline** (one locality group). Spawn cap = 3. Token target: lean.
- No raw color utilities (`zinc/amber/red/green/blue/gray`) or hex — use token utilities only (`text-muted`, `border-line`, `text-danger`, `.btn-secondary`, etc.).
- No hand-rolled button primitives — use `.btn-secondary`/`.btn-primary`.
- New/modified `lib/` modules keep co-located `*.test.ts`; stay above the `vitest.config.ts` coverage floor.
- Role gate for mapping writes: `requireRole(["brewer", "manager"])`. Refresh (catalog sync) stays open to any authenticated user (existing route).
- Migration is **human-gated**: create the file only; do NOT apply to prod. Next migration number is `20260814`.
- DoD: `npm run verify` (lint + typecheck + tests) green.
- Square catalog master tables: `square_catalog_variations.synced_at` exists and is set on each sync.

---

### Task 1: Migration — `recipe_square_link_ignores` table

**Files:**
- Create: `supabase/migrations/20260814_recipe_square_link_ignores.sql`

**Interfaces:**
- Produces: table `public.recipe_square_link_ignores(id uuid, recipe_id uuid, packaging text, variation_id uuid null, created_at timestamptz)`.

- [ ] **Step 1: Write the migration**

```sql
-- Square item-mapping "ignore" list.
-- An ignored cell = a (recipe, packaging-variation) slot deliberately left
-- unmapped. Ignored cells produce no suggestion, are excluded from auto-fill,
-- and show no "missing mapping" warning — but remain mappable later.
-- Grain mirrors recipe_square_links: draft is recipe-grain (variation_id null),
-- keg/can is variation-grain (recipe_id + variation_id).

create table if not exists public.recipe_square_link_ignores (
  id           uuid primary key default gen_random_uuid(),
  recipe_id    uuid not null references public.recipes(id) on delete cascade,
  packaging    text not null check (packaging in ('draft','keg','can')),
  variation_id uuid references public.packaging_variations(id) on delete cascade,
  created_at   timestamptz not null default now()
);

-- One ignore per keg/can cell (recipe + variation), and one per draft cell (recipe).
create unique index if not exists rsli_recipe_variation_uniq
  on public.recipe_square_link_ignores (recipe_id, variation_id)
  where variation_id is not null;
create unique index if not exists rsli_recipe_draft_uniq
  on public.recipe_square_link_ignores (recipe_id)
  where packaging = 'draft';

-- FK index (repo convention — cf. 20260721_add_missing_fk_indexes.sql).
create index if not exists rsli_variation_id_idx
  on public.recipe_square_link_ignores (variation_id);

-- Audit trail, matching recipe_square_links.
drop trigger if exists audit_recipe_square_link_ignores on public.recipe_square_link_ignores;
create trigger audit_recipe_square_link_ignores
  after insert or update or delete on public.recipe_square_link_ignores
  for each row execute function audit_trigger_fn();
```

- [ ] **Step 2: Verify SQL parity with siblings**

Confirm the file mirrors `recipe_square_links` posture: no `enable row level security` (that table has none), audit trigger present, partial-unique indexes on the cell grain. No prod apply.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260814_recipe_square_link_ignores.sql
git commit -m "feat(db): recipe_square_link_ignores table for ignored Square mappings"
```

---

### Task 2: Grid logic — ignore support in `squareMappingGrid.ts` (TDD)

**Files:**
- Modify: `lib/production/squareMappingGrid.ts`
- Test: `lib/production/squareMappingGrid.test.ts`

**Interfaces:**
- Produces:
  - `interface IgnoreRow { id: string; recipeId: string; packaging: "draft" | "keg" | "can"; variationId: string | null }`
  - `CellVariation` gains `ignored: boolean` and `ignoreId: string | null`.
  - `buildGrid(recipes, columns, rpvs, links, sqVars, ignores?: IgnoreRow[]): GridRow[]` — new optional 6th param (defaults to `[]`).
- Consumes: existing `LinkRow`, `CellVariation`, `buildGrid` from this file.

- [ ] **Step 1: Write the failing tests**

Add to `lib/production/squareMappingGrid.test.ts` (import `IgnoreRow` in the type import line, i.e. `import type { RpvRow, SquareCatalogVariationFlat, LinkRow, IgnoreRow } from "./squareMappingGrid";`):

```typescript
// ── buildGrid ignore support ────────────────────────────────────────────────
describe("buildGrid ignores", () => {
  const recipes = [{ id: "r1", beerName: "Epic Hazy IPA", partnerName: null }];
  const rpvs: RpvRow[] = [
    { recipeId: "r1", variationId: "v1", containerType: "can", volumeFlOz: 16, format: "4-pack",
      containerName: "16oz Can", isActive: true, partnerId: null, partnerName: null, variationName: "Epic Hazy IPA - 16oz 4-Pack" },
  ];
  const sqVars: SquareCatalogVariationFlat[] = [
    { squareVariationId: "sv1", squareItemId: "si1", itemName: "Epic Hazy IPA", variationName: "4-Pack", categoryName: "Cans", volumeFlOzPerUnit: 16 },
  ];
  const columns = deriveColumns(rpvs);

  it("nulls the suggestion and flags a keg/can cell ignored", () => {
    const ignores: IgnoreRow[] = [{ id: "ig1", recipeId: "r1", packaging: "can", variationId: "v1" }];
    const rows = buildGrid(recipes, columns, rpvs, [], sqVars, ignores);
    const cell = rows[0].cells["can|16|4-pack"]!;
    const v = cell.variations.find((x) => x.variationId === "v1")!;
    expect(v.ignored).toBe(true);
    expect(v.ignoreId).toBe("ig1");
    expect(v.suggestion).toBeNull();
  });

  it("keys draft ignores by recipe (null variation_id)", () => {
    const ignores: IgnoreRow[] = [{ id: "ig2", recipeId: "r1", packaging: "draft", variationId: null }];
    const rows = buildGrid(recipes, columns, rpvs, [], sqVars, ignores);
    const draft = rows[0].cells["draft"]!.variations[0];
    expect(draft.ignored).toBe(true);
    expect(draft.ignoreId).toBe("ig2");
    expect(draft.suggestion).toBeNull();
  });

  it("linked wins over a stale ignore (not rendered ignored)", () => {
    const links: LinkRow[] = [{ id: "l1", recipeId: "r1", packaging: "can", variationId: "v1",
      squareCatalogVariationId: "cv1", squareVariationId: "sv1", variationName: "4-Pack", itemName: "Epic Hazy IPA" }];
    const ignores: IgnoreRow[] = [{ id: "ig3", recipeId: "r1", packaging: "can", variationId: "v1" }];
    const rows = buildGrid(recipes, columns, rpvs, links, sqVars, ignores);
    const v = rows[0].cells["can|16|4-pack"]!.variations.find((x) => x.variationId === "v1")!;
    expect(v.linkId).toBe("l1");
    expect(v.ignored).toBe(false);
    expect(v.ignoreId).toBeNull();
  });

  it("defaults ignored=false when no ignores passed", () => {
    const rows = buildGrid(recipes, columns, rpvs, [], sqVars);
    const v = rows[0].cells["can|16|4-pack"]!.variations.find((x) => x.variationId === "v1")!;
    expect(v.ignored).toBe(false);
    expect(v.ignoreId).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/production/squareMappingGrid.test.ts`
Expected: FAIL — `ignored`/`ignoreId` undefined; `IgnoreRow` not exported.

- [ ] **Step 3: Implement ignore support**

In `lib/production/squareMappingGrid.ts`:

Add the input type after `LinkRow` (around line 58):

```typescript
export interface IgnoreRow {
  id: string;
  recipeId: string;
  packaging: "draft" | "keg" | "can";
  variationId: string | null; // null for draft
}
```

Extend `CellVariation` (around line 78):

```typescript
export interface CellVariation {
  variationId: string;          // packaging_variation UUID (null string sentinel for draft)
  variationName: string;
  linkId: string | null;
  linkedSquareCatalogVariationId: string | null;
  linkedSquareName: string | null;
  suggestion: Suggestion | null;
  ignored: boolean;
  ignoreId: string | null;
}
```

Update `buildGrid` signature and body. Add the 6th param:

```typescript
export function buildGrid(
  recipes: { id: string; beerName: string; partnerName?: string | null }[],
  columns: ColumnDef[],
  rpvs: RpvRow[],
  links: LinkRow[],
  sqVars: SquareCatalogVariationFlat[],
  ignores: IgnoreRow[] = []
): GridRow[] {
```

After the link indexes (after line 259), add ignore indexes:

```typescript
  // Index ignores identically to links: draft by recipe, keg/can by variation+recipe.
  const ignoreByVariation = new Map<string, IgnoreRow>(); // key: `${variationId}::${recipeId}`
  const draftIgnoreByRecipe = new Map<string, IgnoreRow>();
  for (const ig of ignores) {
    if (ig.packaging === "draft") {
      draftIgnoreByRecipe.set(ig.recipeId, ig);
    } else if (ig.variationId) {
      ignoreByVariation.set(`${ig.variationId}::${ig.recipeId}`, ig);
    }
  }
```

In the **draft** cell builder (replace the block at lines ~291-307):

```typescript
        const link = draftLinkByRecipe.get(recipe.id);
        const ignore = link ? undefined : draftIgnoreByRecipe.get(recipe.id);
        const suggestion = link || ignore
          ? null
          : autoSuggest(recipe.beerName, null, "draft", null, sqVars);
        cells["draft"] = {
          variations: [
            {
              variationId: "draft",
              variationName: "Draft",
              linkId: link?.id ?? null,
              linkedSquareCatalogVariationId: link?.squareCatalogVariationId ?? null,
              linkedSquareName: link
                ? `${link.itemName ?? ""}${link.variationName ? ` · ${link.variationName}` : ""}`.trim()
                : null,
              suggestion,
              ignored: !link && !!ignore,
              ignoreId: ignore?.id ?? null,
            },
          ],
        };
```

In the **keg/can** variation builder (replace the `.map` block at lines ~328-343):

```typescript
      const variations: CellVariation[] = colRpvs.map((rpv) => {
        const link = linkByVariation.get(`${rpv.variationId}::${recipe.id}`);
        const ignore = link ? undefined : ignoreByVariation.get(`${rpv.variationId}::${recipe.id}`);
        const suggestion = link || ignore
          ? null
          : autoSuggest(recipe.beerName, rpv.volumeFlOz, rpv.containerType, rpv.format, sqVars);
        return {
          variationId: rpv.variationId,
          variationName: rpv.variationName,
          linkId: link?.id ?? null,
          linkedSquareCatalogVariationId: link?.squareCatalogVariationId ?? null,
          linkedSquareName: link
            ? `${link.itemName ?? ""}${link.variationName ? ` · ${link.variationName}` : ""}`.trim()
            : null,
          suggestion,
          ignored: !link && !!ignore,
          ignoreId: ignore?.id ?? null,
        };
      });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/production/squareMappingGrid.test.ts`
Expected: PASS (new + existing tests).

- [ ] **Step 5: Commit**

```bash
git add lib/production/squareMappingGrid.ts lib/production/squareMappingGrid.test.ts
git commit -m "feat(mappings): buildGrid ignore support (nulls suggestion for ignored cells)"
```

---

### Task 3: Grid data — fetch ignores + catalogSyncedAt in `mappingGridData.ts`

**Files:**
- Modify: `lib/production/mappingGridData.ts`

**Interfaces:**
- Consumes: `IgnoreRow` from Task 2; `buildGrid` 6-arg signature.
- Produces: `MappingGrid` gains `catalogSyncedAt: string | null`; `fetchMappingGrid` now fetches ignores and threads them into `buildGrid`.

- [ ] **Step 1: Add the ignores fetch + type**

Import `IgnoreRow` in the type import block (top of file):

```typescript
import type {
  RpvRow,
  SquareCatalogVariationFlat,
  LinkRow,
  IgnoreRow,
  ColumnDef,
  GridRow,
} from "@/lib/production/squareMappingGrid";
```

Extend the return type:

```typescript
export interface MappingGrid {
  columns: ColumnDef[];
  rows: GridRow[];
  catalogSyncedAt: string | null;
}
```

Add `synced_at` to the `square_catalog_variations` select (line ~52), so it becomes:

```typescript
    supabase
      .from("square_catalog_variations")
      .select("id, square_variation_id, variation_name, volume_fl_oz_per_unit, synced_at, square_catalog_items ( square_item_id, item_name, category_name )"),
```

Add a 6th parallel fetch to the `Promise.all` destructuring and array — the ignores query:

```typescript
    { data: ignoreData, error: ignoreErr },
```

```typescript
    supabase
      .from("recipe_square_link_ignores")
      .select("id, recipe_id, packaging, variation_id"),
```

Add its error guard alongside the others:

```typescript
  if (ignoreErr) throw new Error(ignoreErr.message);
```

- [ ] **Step 2: Shape ignores + compute catalogSyncedAt + pass to buildGrid**

After `linkRows` is built (around line 138), add:

```typescript
  const ignoreRows: IgnoreRow[] = (ignoreData ?? []).map((ig: Record<string, unknown>) => ({
    id: ig.id as string,
    recipeId: ig.recipe_id as string,
    packaging: ig.packaging as "draft" | "keg" | "can",
    variationId: (ig.variation_id as string | null) ?? null,
  }));

  const catalogSyncedAt = (sqVarData ?? []).reduce<string | null>((max, sv: Record<string, unknown>) => {
    const t = (sv.synced_at as string | null) ?? null;
    return t && (!max || t > max) ? t : max;
  }, null);
```

Update the `buildGrid` call and return:

```typescript
  const columns = deriveColumns(allRpvRows);
  const rows = buildGrid(recipesList, columns, allRpvRows, linkRows, sqVarRows, ignoreRows);

  return { columns, rows, catalogSyncedAt };
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no type errors). If `@/api/taproom/inventory` consumes `MappingGrid`, the added field is additive and non-breaking.

- [ ] **Step 4: Commit**

```bash
git add lib/production/mappingGridData.ts
git commit -m "feat(mappings): fetch ignores + expose catalogSyncedAt in grid data"
```

---

### Task 4: Client types — extend `MappingCellVariation` + response

**Files:**
- Modify: `app/production/types.ts:604-633`

**Interfaces:**
- Produces: `MappingCellVariation` gains `ignored: boolean; ignoreId: string | null`; `MappingGridResponse` gains `catalogSyncedAt: string | null`.

- [ ] **Step 1: Extend the types**

Replace `MappingCellVariation` (lines 604-617) with:

```typescript
export interface MappingCellVariation {
  variationId: string;
  variationName: string;
  linkId: string | null;
  linkedSquareCatalogVariationId: string | null;
  linkedSquareName: string | null;
  suggestion: {
    squareCatalogVariationId: string | null;
    squareVariationId: string;
    squareItemId: string | null;
    squareName: string;
    confidence: "high" | "medium";
  } | null;
  ignored: boolean;
  ignoreId: string | null;
}
```

Replace `MappingGridResponse` (lines 630-633) with:

```typescript
export interface MappingGridResponse {
  columns: MappingColumn[];
  rows: MappingGridRow[];
  catalogSyncedAt: string | null;
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc --noEmit` → PASS.

```bash
git add app/production/types.ts
git commit -m "feat(mappings): client types for ignored cells + catalogSyncedAt"
```

---

### Task 5: Ignore API route (TDD)

**Files:**
- Create: `app/api/production/recipe-square-link-ignores/route.ts`
- Test: `app/api/production/recipe-square-link-ignores/route.test.ts`

**Interfaces:**
- Produces:
  - `POST` body `{ recipe_id: string, packaging: "draft"|"keg"|"can", variation_id?: string }` → 201 with the ignore row (idempotent on conflict).
  - `DELETE ?id=<uuid>` → 204.

- [ ] **Step 1: Write the failing test**

Create `app/api/production/recipe-square-link-ignores/route.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({
  requireRole: vi.fn().mockResolvedValue(undefined),
}));

const upsertCalls: unknown[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    from: vi.fn(() => {
      const chain = {
        upsert: vi.fn((row: unknown) => { upsertCalls.push(row); return chain; }),
        delete: vi.fn(() => chain),
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        single: vi.fn(() => Promise.resolve({ data: { id: "ig-1" }, error: null })),
        then: (resolve: (v: unknown) => void) => resolve({ error: null }),
      };
      return chain;
    }),
  })),
}));

describe("POST /api/production/recipe-square-link-ignores", () => {
  it("upserts a keg/can ignore with variation_id", async () => {
    upsertCalls.length = 0;
    const { POST } = await import("./route");
    const req = new NextRequest("http://localhost/api/production/recipe-square-link-ignores", {
      method: "POST",
      body: JSON.stringify({ recipe_id: "r1", packaging: "can", variation_id: "v1" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(upsertCalls[0]).toMatchObject({ recipe_id: "r1", packaging: "can", variation_id: "v1" });
  });

  it("rejects a keg/can ignore without variation_id", async () => {
    const { POST } = await import("./route");
    const req = new NextRequest("http://localhost/api/production/recipe-square-link-ignores", {
      method: "POST",
      body: JSON.stringify({ recipe_id: "r1", packaging: "can" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("rejects a draft ignore that carries a variation_id", async () => {
    const { POST } = await import("./route");
    const req = new NextRequest("http://localhost/api/production/recipe-square-link-ignores", {
      method: "POST",
      body: JSON.stringify({ recipe_id: "r1", packaging: "draft", variation_id: "v1" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/production/recipe-square-link-ignores", () => {
  it("400s without id", async () => {
    const { DELETE } = await import("./route");
    const req = new NextRequest("http://localhost/api/production/recipe-square-link-ignores", { method: "DELETE" });
    const res = await DELETE(req);
    expect(res.status).toBe(400);
  });

  it("204s with id", async () => {
    const { DELETE } = await import("./route");
    const req = new NextRequest("http://localhost/api/production/recipe-square-link-ignores?id=ig-1", { method: "DELETE" });
    const res = await DELETE(req);
    expect(res.status).toBe(204);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/api/production/recipe-square-link-ignores/route.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the route**

Create `app/api/production/recipe-square-link-ignores/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // brewer (production) and manager (taproom) both edit Square item mappings.
  try { await requireRole(["brewer", "manager"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { recipe_id, packaging, variation_id } = await req.json();

  if (!recipe_id || !packaging) {
    return NextResponse.json({ error: "recipe_id and packaging are required" }, { status: 400 });
  }
  if (packaging !== "draft" && packaging !== "keg" && packaging !== "can") {
    return NextResponse.json({ error: "packaging must be 'draft', 'keg', or 'can'" }, { status: 400 });
  }
  if (packaging === "draft" && variation_id) {
    return NextResponse.json({ error: "draft ignores must not carry a variation_id" }, { status: 400 });
  }
  if ((packaging === "keg" || packaging === "can") && !variation_id) {
    return NextResponse.json({ error: "variation_id is required for keg and can ignores" }, { status: 400 });
  }

  // Idempotent: re-ignoring an already-ignored cell returns the existing row.
  const conflict = packaging === "draft" ? "recipe_id" : "recipe_id,variation_id";
  const { data, error } = await supabase
    .from("recipe_square_link_ignores")
    .upsert(
      { recipe_id, packaging, variation_id: variation_id || null },
      { onConflict: conflict, ignoreDuplicates: false }
    )
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  try { await requireRole(["brewer", "manager"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const { error } = await supabase.from("recipe_square_link_ignores").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
```

Note on the partial-unique `onConflict`: Postgres upsert on a partial index works when the conflict target matches. If the draft partial-unique index (`where packaging='draft'`) rejects the `onConflict: "recipe_id"` target at runtime, fall back to a pre-check: `select id ... eq(recipe_id).eq(packaging,'draft')` then insert-or-return. Keep the test green either way (the mock returns `{ id: "ig-1" }`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/api/production/recipe-square-link-ignores/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/production/recipe-square-link-ignores/
git commit -m "feat(mappings): ignore API route (POST upsert / DELETE)"
```

---

### Task 6: Clear a stale ignore when a link is created

**Files:**
- Modify: `app/api/production/recipe-square-links/route.ts:73-85`

**Interfaces:**
- Consumes: `recipe_square_link_ignores` table.
- Produces: after a link's dedup-delete, any matching ignore row for the same cell is removed (best-effort).

- [ ] **Step 1: Add ignore cleanup alongside the existing dedup-delete**

In `POST`, extend the existing draft/keg-can dedup block (lines 73-85) so it also clears the matching ignore. Replace that block with:

```typescript
  if (packaging === "draft") {
    await supabase
      .from("recipe_square_links")
      .delete()
      .eq("recipe_id", recipe_id)
      .eq("packaging", "draft");
    // A cell is never both linked and ignored — clear any stale draft ignore.
    await supabase
      .from("recipe_square_link_ignores")
      .delete()
      .eq("recipe_id", recipe_id)
      .eq("packaging", "draft");
  } else if (variation_id) {
    await supabase
      .from("recipe_square_links")
      .delete()
      .eq("recipe_id", recipe_id)
      .eq("square_variation_id", square_variation_id);
    await supabase
      .from("recipe_square_link_ignores")
      .delete()
      .eq("recipe_id", recipe_id)
      .eq("variation_id", variation_id);
  }
```

- [ ] **Step 2: Verify existing route test still passes**

Run: `npx vitest run app/api/production/recipe-square-links/route.test.ts`
Expected: PASS. The test's mock chain supports `.delete().eq()...`; the added ignore-delete uses the same chain and records no `deleteEqCalls` (guarded to `table === "recipe_square_links"`), so assertions are unaffected.

- [ ] **Step 3: Commit**

```bash
git add app/api/production/recipe-square-links/route.ts
git commit -m "feat(mappings): clear stale ignore when a link is created"
```

---

### Task 7: Auto-refresh on load — `useSquareMappingGridQuery`

**Files:**
- Modify: `app/production/hooks/queries.ts:157-162`

**Interfaces:**
- Produces: grid query refetches on every mount (recompute suggestions over synced catalog).

- [ ] **Step 1: Override stale defaults on the grid query**

Replace `useSquareMappingGridQuery` (lines 157-162) with:

```typescript
export function useSquareMappingGridQuery() {
  return useQuery({
    queryKey: ["production", "square-mapping-grid"] as const,
    queryFn: () => fetchJson<MappingGridResponse>("/api/production/recipe-square-links?grid=1"),
    // The Square catalog changes out-of-band; recompute suggestions on every visit.
    staleTime: 0,
    refetchOnMount: "always",
  });
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc --noEmit` → PASS.

```bash
git add app/production/hooks/queries.ts
git commit -m "feat(mappings): recompute suggestions on every grid mount"
```

---

### Task 8: Grid UI — refresh toolbar + ignored chip

**Files:**
- Modify: `app/production/settings/square-links/MappingGrid.tsx`

**Interfaces:**
- Consumes: `MappingCellVariation.ignored`, `MappingGridResponse.catalogSyncedAt`, `POST /api/finance/sync-catalog`, `queryKeys.production.squareCatalog()`.

- [ ] **Step 1: Add imports + relative-time helper**

At the top of `MappingGrid.tsx`, add to the imports:

```typescript
import { useState } from "react";
import { queryKeys } from "@/lib/query-keys";
```

Above the component, add a small helper:

```typescript
function syncedAgo(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}
```

- [ ] **Step 2: Add refresh state + handler inside the component**

After `const qc = useQueryClient();` (line 58), add:

```typescript
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  async function refreshFromSquare() {
    setSyncing(true);
    setSyncError(null);
    try {
      const res = await fetch("/api/finance/sync-catalog", { method: "POST" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { error?: string }).error ?? "Sync failed");
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["production", "square-mapping-grid"] }),
        qc.invalidateQueries({ queryKey: queryKeys.production.squareCatalog() }),
      ]);
    } catch (err) {
      setSyncError((err as Error).message);
    } finally {
      setSyncing(false);
    }
  }
```

Note: the early returns for `isLoading`/`error` are before this — move the two `useState` lines and `refreshFromSquare` **above** the `if (isLoading)` guard (React hooks must run unconditionally). Place them immediately after `const qc = useQueryClient();`.

- [ ] **Step 3: Render the toolbar**

Replace the opening `return (<div>` and the banner block (lines 122-136) with a persistent toolbar above the banner:

```tsx
  const syncedLabel = syncedAgo(data.catalogSyncedAt);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button onClick={refreshFromSquare} disabled={syncing} className="btn-secondary">
            {syncing ? "Syncing…" : "Refresh from Square"}
          </button>
          {syncedLabel && (
            <span className="text-xs text-muted">Catalog synced {syncedLabel}</span>
          )}
        </div>
        {syncError && <span className="text-xs text-danger">{syncError}</span>}
      </div>

      {totalHigh > 0 && (
        <div className="mb-3 flex items-center justify-between rounded-lg border border-info-border/40 bg-info-surface/20 px-4 py-2.5">
          <span className="text-sm text-info">
            {totalHigh} high-confidence suggestion{totalHigh !== 1 ? "s" : ""} ready to accept
          </span>
          <button onClick={fillAll} className="btn-primary">
            Fill all suggested
          </button>
        </div>
      )}
```

(Keep the rest of the JSX — the `<div className="overflow-x-auto ...">` table — unchanged.)

- [ ] **Step 4: Guard counts against ignored cells (belt-and-suspenders)**

In `countHighConfidence` (line 72), change the condition to also require not-ignored:

```typescript
        if (!v.linkId && !v.ignored && v.suggestion?.confidence === "high") result.push(v);
```

In `fillColumn` (line 87), change the filter to:

```typescript
          .filter((v) => !v.linkId && !v.ignored && v.suggestion?.confidence === "high")
```

- [ ] **Step 5: Render the ignored chip**

In the cell render, add an **ignored** branch immediately before the red "Unmapped, no suggestion" return (before line 272-280). Insert:

```tsx
                            if (v.ignored) {
                              return (
                                <span
                                  key={v.variationId}
                                  className="inline-block px-1.5 py-0.5 rounded text-[10px] border border-line text-muted bg-surface-mid/40 break-words leading-4"
                                  title="Ignored — no Square mapping needed"
                                >
                                  {label ? `${label}: ` : ""}Ignored
                                </span>
                              );
                            }
```

- [ ] **Step 6: Verify build + lint**

Run: `npm run build` (or `npx tsc --noEmit` + `npx eslint app/production/settings/square-links/MappingGrid.tsx`)
Expected: no type/lint errors. Confirm no raw-color utilities were introduced.

- [ ] **Step 7: Commit**

```bash
git add app/production/settings/square-links/MappingGrid.tsx
git commit -m "feat(mappings): refresh-from-Square toolbar + ignored cell chip"
```

---

### Task 9: Drawer UI — ignore / un-ignore

**Files:**
- Modify: `app/production/settings/square-links/MappingDrawer.tsx`

**Interfaces:**
- Consumes: `POST` / `DELETE /api/production/recipe-square-link-ignores`, `MappingCellVariation.ignored`/`ignoreId`.

- [ ] **Step 1: Add ignore + un-ignore handlers**

Inside the component, after `handleRemove` (line 205), add:

```typescript
  async function handleIgnore(v: MappingCellVariation) {
    setSaving((s) => ({ ...s, [v.variationId]: true }));
    setErrors((e) => ({ ...e, [v.variationId]: "" }));
    try {
      const body: Record<string, unknown> = { recipe_id: recipeId, packaging: col!.type };
      if (v.variationId !== "draft") body.variation_id = v.variationId;
      const res = await fetch("/api/production/recipe-square-link-ignores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { error?: string }).error ?? "Ignore failed");
      }
      qc.invalidateQueries({ queryKey: ["production", "square-mapping-grid"] });
    } catch (err) {
      setErrors((e) => ({ ...e, [v.variationId]: (err as Error).message }));
    } finally {
      setSaving((s) => ({ ...s, [v.variationId]: false }));
    }
  }

  async function handleUnignore(v: MappingCellVariation) {
    if (!v.ignoreId) return;
    setSaving((s) => ({ ...s, [v.variationId]: true }));
    try {
      const res = await fetch(`/api/production/recipe-square-link-ignores?id=${v.ignoreId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Un-ignore failed");
      qc.invalidateQueries({ queryKey: ["production", "square-mapping-grid"] });
    } catch (err) {
      setErrors((e) => ({ ...e, [v.variationId]: (err as Error).message }));
    } finally {
      setSaving((s) => ({ ...s, [v.variationId]: false }));
    }
  }
```

- [ ] **Step 2: Branch the drawer body on ignored + add the Ignore action**

In the `cell.variations.map` body (lines 237-296), the current structure is `isLinked ? (linked) : (suggestion+combobox)`. Change it to a three-way: linked → ignored → unlinked. Replace the `{isLinked ? ( ... ) : ( ... )}` expression with:

```tsx
                {isLinked ? (
                  <div className="flex items-center justify-between rounded-lg border border-success-border/40 bg-success-surface/20 px-3 py-2">
                    <span className="text-xs text-success">✓ {v.linkedSquareName}</span>
                    <button
                      onClick={() => handleRemove(v)}
                      disabled={isBusy}
                      className="text-xs text-faint hover:text-danger transition-colors disabled:opacity-30 ml-3 shrink-0"
                    >
                      Remove
                    </button>
                  </div>
                ) : v.ignored ? (
                  <div className="flex items-center justify-between rounded-lg border border-line bg-surface-mid/40 px-3 py-2">
                    <span className="text-xs text-muted">Ignored — no Square mapping needed</span>
                    <button
                      onClick={() => handleUnignore(v)}
                      disabled={isBusy}
                      className="text-xs text-faint hover:text-accent transition-colors disabled:opacity-30 ml-3 shrink-0"
                    >
                      Require mapping
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {v.suggestion &&
                      (v.suggestion.confidence === "high" || v.suggestion.confidence === "medium") && (
                        <div className="flex items-center justify-between rounded-lg border border-info-border/40 bg-info-surface/20 px-3 py-2">
                          <span className="text-xs text-info truncate mr-2">
                            Suggested: {v.suggestion.squareName}
                          </span>
                          <button
                            onClick={() => handleAccept(v, v.suggestion!.squareVariationId)}
                            disabled={isBusy}
                            className="btn-primary shrink-0"
                          >
                            Accept
                          </button>
                        </div>
                      )}
                    <VariationCombobox
                      value={pendingId}
                      onChange={(id) =>
                        setPendingSelections((p) => ({ ...p, [v.variationId]: id }))
                      }
                      variations={filteredVars}
                    />
                    {pendingId && (
                      <button
                        onClick={() => handleAccept(v, pendingId)}
                        disabled={isBusy}
                        className="btn-primary w-full"
                      >
                        {isBusy ? "Saving…" : "Link"}
                      </button>
                    )}
                    <button
                      onClick={() => handleIgnore(v)}
                      disabled={isBusy}
                      className="text-xs text-faint hover:text-secondary transition-colors disabled:opacity-30"
                    >
                      Ignore — no Square mapping needed
                    </button>
                    {err && <p className="text-xs text-danger">{err}</p>}
                  </div>
                )}
```

- [ ] **Step 3: Verify build + lint**

Run: `npx tsc --noEmit` + `npx eslint app/production/settings/square-links/MappingDrawer.tsx`
Expected: PASS, no raw colors.

- [ ] **Step 4: Commit**

```bash
git add app/production/settings/square-links/MappingDrawer.tsx
git commit -m "feat(mappings): ignore / require-mapping controls in the drawer"
```

---

### Task 10: Full verification

- [ ] **Step 1: Run the DoD command**

Run: `npm run verify`
Expected: lint + typecheck + tests all PASS.

- [ ] **Step 2: Manual smoke (browser, optional)**

Start the dev server (via preview_start `name`), open `/production/settings/square-links`:
- "Refresh from Square" button visible; click → "Syncing…" → grid refetches.
- Open a cell drawer on an unmapped cell → "Ignore — no Square mapping needed" → cell shows muted "Ignored", drops from any suggestion count.
- Re-open the ignored cell → "Require mapping" → suggestion/combobox returns.
- Confirm an ignored cell is not counted in "N high-confidence suggestions" / "Fill all".

- [ ] **Step 3: Final commit (if smoke fixes needed)**

```bash
git add -A && git commit -m "fix(mappings): smoke-test adjustments"
```

---

## Human-gated follow-ups (do NOT do from an agent)

- Apply `supabase/migrations/20260814_recipe_square_link_ignores.sql` to prod **only** after explicit user OK + backup.
- Open the PR after `npm run verify` is green.

## Self-Review notes

- **Spec coverage:** Feature 1 → Task 8 (+ reused sync route). Feature 2 → Task 7. Feature 3 → Tasks 1–6, 8–9. `catalogSyncedAt` hint → Tasks 3, 4, 8. Tests → Tasks 2, 5 (+ Task 6 regression). All spec sections mapped.
- **Type consistency:** `IgnoreRow` shape identical in Tasks 2/3; `ignored`/`ignoreId` names consistent across `CellVariation` (Task 2) and `MappingCellVariation` (Task 4) and consumers (Tasks 8/9); `catalogSyncedAt` consistent across `MappingGrid` (Task 3), `MappingGridResponse` (Task 4), UI (Task 8).
- **Placeholder scan:** none — every code step shows full code.
