# Retiring the legacy Square string columns on `recipe_square_links`

## Root cause (why we are here)

`recipe_square_links` maps a recipe + packaging to a Square catalog variation. It
carries **two parallel identities** for the Square side of that mapping:

- **Legacy string columns** — `square_variation_id` (Square-native id, `NOT NULL`),
  `square_item_id`, `variation_name`, `item_name`. These were the original mapping
  and are still both **written** (the POST route requires `square_variation_id`)
  and **read** (the grid renders the linked item from `variation_name` / `item_name`).
- **FK columns** — `catalog_variation_id → square_catalog_variations(id)` and
  `catalog_item_id → square_catalog_items(id)`, added in
  `20260613_square_catalog_extend` and backfilled by
  `20260613_backfill_recipe_link_variation_ids`. These are the intended
  source of truth going forward.

Separately, the **production** side of the mapping was re-grained from container
identity to `variation_id → packaging_variations(id)` in
`20260710_recipe_square_links_variation_grain`. That backfill matched candidates
on `packaging_variations.container_id = link.packaging_item_id`, which broke for:

- **partner kegs / printed cans** — `20260627_printed_can_and_partner_kegs`
  repointed them onto NEW beer-specific container items, so a link's legacy
  `packaging_item_id` no longer equals any variation's `container_id`; and
- **generic house kegs** — which never received `recipe_packaging_variations`
  rows, so the recipe→variation join found zero candidates.

The net effect is **50 non-draft rows with `variation_id` NULL** (keg links =
0-candidate; can links = a mix of 0-candidate and ambiguous multi-format). We
cannot retire the legacy string columns while rows are still keyed only by those
strings and the FK/`variation_id` grain is incomplete.

## Target end state

Every non-draft `recipe_square_links` row is keyed by
`variation_id → packaging_variations` on the production side and
`catalog_variation_id → square_catalog_variations` on the Square side. The four
legacy string columns (`square_variation_id`, `square_item_id`, `variation_name`,
`item_name`) are dropped. Draft rows remain recipe-grain (`variation_id` NULL).

## Sequence (do not skip or reorder)

### (a) Backfill kegs + unambiguous cans — **this migration**

`supabase/migrations/20260723_backfill_recipe_square_links_keg_variation.sql`
sets `variation_id` by size-matching (keg `volume_fl_oz` through
`recipe_packaging_variations`, with a shared-generic fallback), plus the
single-active-variation can rows. Safe-by-construction (`count(*) = 1` guarded),
idempotent (`variation_id IS NULL` only), and drops nothing.

- Run the CTEs as SELECTs first to confirm counts.
- After applying, expect the keg NULLs to clear and the count=1 cans to clear;
  genuinely ambiguous multi-format cans **intentionally remain NULL** for step (b).

### (b) Resolve residual ambiguous cans in the mapping-grid UI

The remaining NULL cans are multi-format / collision cases (e.g. loose vs 4-pack
vs case on a shared blank container, or the Epic Hazy "Printed Can" vs "Be Like
Mike Labeled Can" 16oz collision) that no deterministic rule can pick safely.
Resolve them by hand through the existing mapping grid:

- `lib/production/squareMappingGrid.ts` — `autoSuggest` / `buildGrid` produce the
  per-cell suggestions and linkable slots.
- `lib/production/mappingGridData.ts` — `fetchMappingGrid` feeds the grid.
- `POST /api/production/recipe-square-links` — persists each chosen link
  (`app/production/settings/square-links/MappingGrid.tsx` + `MappingDrawer.tsx`
  are the client UI that submit it).

Exit criteria for (b): no non-draft row is left NULL for a reason other than "no
Square variation exists yet."

### (c) Migrate the readers off the string columns — **do this before the drop**

The string columns still have live readers **and one required writer**. These
must move to `catalog_variation_id → square_catalog_variations` (joined to
`square_catalog_items` for the item/category fields) before the columns can go.
Files that block the drop today:

1. **`app/api/production/recipe-square-links/route.ts`** (the writer + a reader)
   - `POST` **requires** `square_variation_id` (returns 400 without it) and
     **inserts** `square_variation_id`, `square_item_id`, `variation_name`,
     `item_name`. It already resolves `catalog_variation_id` / `catalog_item_id`
     from the Square-native strings — flip this so the request carries the
     `square_catalog_variations.id` (FK) directly and the string columns are no
     longer written or required.
   - `GET` (legacy flat, no `?grid`) does `select("*")`, so it returns the string
     columns to whatever consumes the flat endpoint — audit those consumers too.
2. **`lib/production/mappingGridData.ts`** — `fetchMappingGrid` selects
   `square_variation_id, variation_name, item_name` and maps them into `LinkRow`.
   Switch the select to join `square_catalog_variations` /
   `square_catalog_items` via `catalog_variation_id` and read the display name
   from there.
3. **`lib/production/squareMappingGrid.ts`** — the `LinkRow` type carries
   `squareVariationId` / `variationName` / `itemName`, and `buildGrid` renders
   each cell's `linkedSquareName` from `itemName` / `variationName`. Re-source
   `linkedSquareName` from the joined catalog rows (the grid already carries
   `squareCatalogVariationId` = `catalog_variation_id`).
4. **`app/production/settings/square-links/MappingDrawer.tsx`** (+ `MappingGrid.tsx`)
   — builds the POST body from `square_variation_id` / `variation_name` /
   `item_name`. Update to send the catalog FK once (1) accepts it.

> Note: `20260613_backfill_recipe_link_variation_ids` (the
> `backfill_recipe_link_variation_ids()` function) matches
> `rsl.square_variation_id = scv.square_variation_id`. It is a one-shot backfill,
> not a live reader, but re-running it after the drop would fail — remove or
> retire the function as part of (e).

### (d) Verify zero residual NULLs

```sql
select count(*)
from public.recipe_square_links
where packaging <> 'draft'
  and variation_id is null;
-- must return 0
```

Also confirm every non-draft row has a non-null `catalog_variation_id` before the
drop (the Square side must be fully on the FK):

```sql
select count(*)
from public.recipe_square_links
where packaging <> 'draft'
  and catalog_variation_id is null;
-- must return 0
```

### (e) Drop the four legacy columns

Only after (a)–(d) are green and (c)'s readers/writer have shipped, add a new
migration that drops `square_variation_id`, `square_item_id`, `variation_name`,
and `item_name` (and retires `backfill_recipe_link_variation_ids()`). Do **not**
hand-edit an existing migration — add a new dated file per the schema-change rule.

## Blockers summary (what reads/writes the string columns today)

| File | Column(s) | Role |
| --- | --- | --- |
| `app/api/production/recipe-square-links/route.ts` | `square_variation_id` (required), `square_item_id`, `variation_name`, `item_name` | **Writer** (POST insert + 400 guard) and reader (GET `select *`) |
| `lib/production/mappingGridData.ts` | `square_variation_id`, `variation_name`, `item_name` | Reader (grid select → `LinkRow`) |
| `lib/production/squareMappingGrid.ts` | `squareVariationId`, `variationName`, `itemName` | Reader (renders `linkedSquareName`) |
| `app/production/settings/square-links/MappingDrawer.tsx`, `MappingGrid.tsx` | `square_variation_id`, `variation_name`, `item_name` | Writer (builds POST body) |
| `supabase/migrations/20260613_backfill_recipe_link_variation_ids.sql` | `square_variation_id` | One-shot backfill fn (retire in step e) |

All four columns must be off every reader and writer above — with `catalog_variation_id`
carrying the Square identity — before step (e) can safely drop them.
