# Square Item Mappings — Refresh & Ignore

**Date:** 2026-07-23
**Status:** Approved design, ready for implementation plan
**Area:** `app/production/settings/square-links/` (shared with `app/taproom/settings/square-links/`)

## Goal

Three additions to the Square item-mappings grid:

1. **Refresh from Square** — a manual button that re-syncs the Square catalog from Square's API, then recomputes suggestions.
2. **Auto-refresh on load** — every visit recomputes suggestions over the currently-synced catalog (no Square API call on load).
3. **Ignore a mapping** — mark a cell as "no Square mapping needed" so it stops producing a suggestion, is excluded from the "Fill all" auto-fill, and no longer shows the red warning chip — while remaining fully mappable later.

## Background (current behavior)

- Suggestions are **computed server-side on every grid fetch** (`autoSuggest` in `lib/production/squareMappingGrid.ts`) and never persisted. `buildGrid` calls `autoSuggest` only for cells with no existing link.
- The grid is served by `GET /api/production/recipe-square-links?grid=1` → `fetchMappingGrid(supabase)` in `lib/production/mappingGridData.ts`.
- Client query: `useSquareMappingGridQuery()` in `app/production/hooks/queries.ts` — inherits global defaults (`staleTime: 30_000`, `refetchOnWindowFocus: false`). Fetches on mount; re-fetches via `qc.invalidateQueries({ queryKey: ["production", "square-mapping-grid"] })` after mutations.
- **Cell grain** (the atomic mapping unit): draft = `(recipe_id, packaging='draft')` with sentinel `variationId="draft"`; keg/can = `(recipe_id, variation_id)` where `variation_id` is a `packaging_variations` UUID. This matches the link uniqueness `(variation_id, recipe_id)` from `20260628_rsl_variation_recipe_uniq.sql`.
- **Auto-fill** = `fillColumn`/`fillAll` in `MappingGrid.tsx`, accepting every `!v.linkId && v.suggestion?.confidence === "high"` cell.
- **"Warning"** for an unmapped cell = the red `border-danger` "—" chip rendered when a variation has no `linkId` and no `suggestion` (`MappingGrid.tsx` lines ~272–280).
- **No "ignore" concept exists** today. Precedent for a manual dismissal flag: `unmapped_accepted` (`20260730_transactions_unmapped_accepted.sql`).
- A full catalog re-sync entrypoint already exists: `POST /api/finance/sync-catalog` (`app/api/finance/sync-catalog/route.ts`) — upserts `square_catalog_items` + `square_catalog_variations`, calls `revalidateTag("square-catalog","max")`, gated `requireRole([])` (any authenticated user). **Reused as-is.**

## Feature 1 — Refresh from Square (manual button)

**UI:** a persistent toolbar at the top of `MappingGrid`, above the conditional "N high-confidence suggestions" banner, so it renders even when there are zero suggestions.

- Button label **"Refresh from Square"** (`.btn-secondary`). While in flight, disabled + label **"Syncing…"**.
- Next to it, a muted **"Catalog synced {relative} ago"** hint derived from `max(synced_at)` across catalog rows (see payload change below). Hidden if unknown.
- On error, inline `text-danger` message.

**Handler:**
1. `POST /api/finance/sync-catalog`.
2. On success, invalidate **both** `["production","square-mapping-grid"]` **and** `queryKeys.production.squareCatalog()` (so the drawer combobox reflects new variations).
3. On failure, surface the error inline; do not invalidate.

Use local `useState` for the in-flight/error state (matches the existing `fetch`-based style in this feature; no `useMutation`).

**Payload change (optional, small):** `fetchMappingGrid` returns an added `catalogSyncedAt: string | null` = `max(synced_at)` from `square_catalog_variations` (already fetched). Threaded through the API response and `MappingGridData` type. If deemed out of scope during planning, the hint can be dropped without affecting features 1–3 core behavior.

**Role:** available to all authenticated users (the sync route already permits any role; it only refreshes read-only catalog data). No new UI role-gating.

## Feature 2 — Auto-refresh on load

Override the global stale defaults **only** on `useSquareMappingGridQuery` (`app/production/hooks/queries.ts`):

```ts
useQuery({
  queryKey: [...],
  queryFn: ...,
  staleTime: 0,
  refetchOnMount: "always",
})
```

Every mount recomputes suggestions over the currently-synced catalog. **Do not** change `app/providers.tsx` (global). **Do not** trigger a Square API sync on load — that is the button's job.

## Feature 3 — Ignore a mapping

### Schema — migration `20260814_recipe_square_link_ignores.sql`

New table `public.recipe_square_link_ignores`:

| column | type | notes |
|---|---|---|
| `id` | uuid PK default `gen_random_uuid()` | |
| `recipe_id` | uuid not null → `recipes(id)` on delete cascade | |
| `packaging` | text not null | check in (`'draft'`,`'keg'`,`'can'`) |
| `variation_id` | uuid → `packaging_variations(id)` on delete cascade | **null for draft** |
| `created_at` | timestamptz not null default `now()` | |

Indexes / constraints (mirror the cell grain):
- `create unique index ... on recipe_square_link_ignores (recipe_id, variation_id) where variation_id is not null;`
- `create unique index ... on recipe_square_link_ignores (recipe_id) where packaging = 'draft';`
- FK index on `variation_id` (per repo convention, cf. `20260721_add_missing_fk_indexes.sql`).

**RLS:** mirror `recipe_square_links`' posture exactly — inspect the baseline in the migration step. If `recipe_square_links` has no explicit RLS policy, follow the same (no RLS / authenticated) posture so the route's user-session Supabase client can read/write; do not lock it stricter than the links table it parallels. Writes are gated at the app layer (below).

**Human-gated:** apply to prod only after explicit user OK + backup (per repo migration rules). Do not apply from a subagent.

### API — new route `app/api/production/recipe-square-link-ignores/route.ts`

Mirror the shape of `recipe-square-links/route.ts`.

- `POST` — role `["brewer","manager"]` via `requireRole`. Body `{ recipe_id: string, packaging: "draft"|"keg"|"can", variation_id?: string }`. Insert one ignore row. Idempotent: on unique-constraint conflict, upsert/no-op (return the existing row rather than 500). Reject if `packaging !== 'draft'` and `variation_id` missing, and vice-versa (draft must have null `variation_id`).
- `DELETE ?id=<uuid>` — role `["brewer","manager"]`. Delete by id.
- Use the same Supabase client the links route uses (server/user-session client). Wrap errors with the route's existing error pattern.

### Grid data — `lib/production/mappingGridData.ts`

- Fetch all `recipe_square_link_ignores` rows (parallel with the existing fetches): `id, recipe_id, packaging, variation_id`.
- Map to an `IgnoreRow[]` and pass into `buildGrid`.

### Grid logic — `lib/production/squareMappingGrid.ts`

- Add `IgnoreRow` input type: `{ id, recipeId, packaging, variationId: string | null }`.
- Extend `CellVariation` with `ignored: boolean` and `ignoreId: string | null`.
- In `buildGrid`, build an ignore index mirroring the link index: draft → `ignoreByRecipe` keyed by `recipeId`; keg/can → `ignoreByVariation` keyed by `${variationId}::${recipeId}`.
- For each `CellVariation`:
  - Determine `ignore` = matching ignore row (only meaningful when **not linked**).
  - Set `ignored = !!ignore && !linkId`, `ignoreId = ignore?.id ?? null`.
  - **When ignored, set `suggestion = null`** (so it drops out of banner counts, `fillColumn`/`fillAll`, and the red warning chip automatically).
  - **Priority:** linked > ignored > suggestion > unmapped-warning. A linked cell is never rendered as ignored; a stale ignore on a now-linked cell is ignored by the UI (and cleaned up on link — see below).

### Link creation clears a stale ignore

In `app/api/production/recipe-square-links/route.ts` `POST` (after a successful link insert), best-effort delete any matching ignore row for `(recipe_id, variation_id)` (or `(recipe_id, packaging='draft')`). Preserves the invariant "a cell is never both linked and ignored." Failure of this cleanup must not fail the link POST (fire-and-forget / ignore error).

### Types — `app/production/types.ts`

Extend `MappingCellVariation` to include `ignored: boolean` and `ignoreId: string | null` (mirror of `CellVariation`). Add `catalogSyncedAt` to the grid data type if the sync-hint payload is kept.

### Grid UI — `MappingGrid.tsx`

- Add the refresh toolbar (Feature 1).
- `countHighConfidence` and `fillColumn`: add an explicit `!v.ignored` guard (belt-and-suspenders; suggestion is already nulled for ignored cells).
- Cell rendering: add an **ignored** branch **before** the red unmapped-warning branch — a muted grey chip reading **"Ignored"** (use `text-muted` / `border-line` tokens; optional short `{label}:` prefix in multi-variation cells, matching the other branches). No red warning for ignored cells.

### Drawer UI — `MappingDrawer.tsx`

Per variation (`cell.variations.map`):
- **Linked** → unchanged (shows linked + Remove).
- **Not linked, not ignored** → existing suggestion row + combobox, **plus** a subtle secondary action **"Ignore — no Square mapping needed"**. On click: `POST /api/production/recipe-square-link-ignores` with `{ recipe_id, packaging: col.type, variation_id? }` (omit `variation_id` when `v.variationId === "draft"`), then invalidate the grid query.
- **Ignored** (`v.ignored`) → an "Ignored" state panel with a **"Require mapping"** button. On click: `DELETE /api/production/recipe-square-link-ignores?id=${v.ignoreId}`, then invalidate. After un-ignoring, the suggestion + combobox reappear (next grid recompute), so it's mappable again.
- Reuse the existing per-variation `saving`/`errors` local-state maps for the ignore/un-ignore calls.

## Testing

- **`lib/production/squareMappingGrid.test.ts`** (extend):
  - Ignored keg/can cell → `ignored=true`, `ignoreId` set, `suggestion=null`; excluded from any high-confidence gathering.
  - Ignored draft cell keyed by `recipeId` (null `variation_id`).
  - A linked cell with a stale ignore row → rendered linked, `ignored=false` (linked wins).
  - Non-ignored unmapped cell unchanged (still gets suggestion / warning as before).
- **`app/api/production/recipe-square-link-ignores/route.test.ts`** (new): POST inserts + role gate (403 for viewer); POST idempotent on conflict; DELETE by id; draft vs variation validation.
- **DoD:** `npm run verify` (lint + typecheck + tests) green. Keep `lib/` coverage above the `vitest.config.ts` floor.

## Files touched (one locality group)

- `supabase/migrations/20260814_recipe_square_link_ignores.sql` (new)
- `app/api/production/recipe-square-link-ignores/route.ts` (new) + `route.test.ts` (new)
- `app/api/production/recipe-square-links/route.ts` (clear-ignore-on-link)
- `lib/production/mappingGridData.ts`
- `lib/production/squareMappingGrid.ts` (+ `squareMappingGrid.test.ts`)
- `app/production/types.ts`
- `app/production/hooks/queries.ts`
- `app/production/settings/square-links/MappingGrid.tsx`
- `app/production/settings/square-links/MappingDrawer.tsx`

## Decisions locked

- Refresh: full Square re-sync on the button; recompute-only on load ("Both" option).
- Ignore UX: drawer toggle + muted grey cell (no inline grid dismiss).
- Refresh available to all authenticated users; ignore/accept remain brewer+ via the route.
- Ignore stored in a dedicated table (not a flag on `recipe_square_links`, since an unmapped-but-ignored cell has no link row).

## Out of scope

- No inline per-cell dismiss (×) in the grid.
- No background Square sync on page load.
- No bulk "ignore column" action (only per-cell via drawer).
