# Deterministic draft keg swaps — design

**Date:** 2026-07-05
**Status:** Approved design, pending implementation plan
**Area:** Taproom draft stats, taproom-consumption sync, cold storage

## Overview

Make the bartender-rung **Draft Restock** line item the *single, deterministic* path
for a draft keg swap. One restock ring produces exactly one clean motion:

1. a `taproom`-channel **shipment** (`export_transactions`) draining cold storage,
2. a **cold-storage inventory deduction** of the mapped keg,
3. a **Square recount** of the tap's draft SKU back to its full-keg volume,
4. a **deterministic shrinkage record** (beer left in the keg at swap time).

Everything that guessed at swaps by inferring physical-count crossings is removed.
All swap configuration is consolidated **per tap** inside a relabeled **Configure
Taps** panel, and the "which keg do we drain" choice is sourced from **actual
cold-storage on-hand kegs** instead of a static recipe→packaging link (which fixes
a current bug where the swap-keg dropdown is empty).

## Goals

- Restock line items are the only source of draft-swap consumption.
- Swap configuration (restock line, keg to drain, full-keg volume) lives on the
  **tap**, edited entirely within Configure Taps, with clear per-field labels.
- The swap-keg dropdown offers only kegs that actually exist in cold storage for
  the tap's recipe, so a selection is always deductible. Auto-map fills them.
- Shrinkage tracking is preserved but made deterministic — derived from the swap
  event, not inferred from count crossings.

## Non-goals

- No change to keg-sale / can-sale taproom consumption (separate, untouched path).
- No change to how the tap cards compute fl-oz-avail / BBL / days-left (those come
  from sell-through, not from swap detection).
- No move to real-time webhooks; the reconciling sync (manual button + daily cron)
  stays the execution model.
- No change to the Square catalog "Draft Restock" item setup flow.

## Current state (as built)

- **Deterministic path already exists.** `lib/square/taproomConsumption.ts`
  (`assembleConsumption`) turns each `RestockLineEvent` into a `draft_swap`
  `ConsumptionUnit` with a `recount` instruction; `lib/production/taproomConsumptionSync.ts`
  records the shipment via `recordTaproomConsumption` (sourceRef
  `sqtransfer:<orderId>:<lineUid>`, idempotent) and fires the recount via
  `setPhysicalCount` once, on the first run that durably records the swap.
- **Fuzzy fallback still present.** `assembleConsumption` also infers swaps from
  physical-count crossings (`detectKegSwaps` in `lib/square/draftKegEvents.ts`),
  skipping recipes that have a restock mapping. This is the path being removed.
- **Swap config is per-recipe.** `taproom_recipe_settings.swap_variation_id` +
  `swap_volume_fl_oz`, edited in the bottom `DraftSwapInventorySection` of
  `app/taproom/components/DraftStatsTab.tsx`.
- **Swap-keg dropdown bug.** That section sources options from
  `recipe_packaging_variations` (keg-type). Taproom draft recipes have no keg
  variation linked there, so the dropdown is empty — even though those beers sit
  in `cold_storage_inventory` as "1/6 Keg" lots. (The filter itself is correct;
  `TransferModal.tsx` uses the identical filter successfully. The source table is
  wrong.)
- **Shrinkage is inferred.** `app/api/taproom/draft-stats/route.ts` runs
  `detectKegSwaps` over physical counts to build `shrinkage_by_recipe` for the
  Draft Shrinkage chart.

## Design

### 1. Data model

**Move swap config from recipe grain to tap grain.** New migration:

- `alter table tap_assignments`
  - `add column swap_variation_id uuid references packaging_variations(id) on delete set null`
  - `add column swap_volume_fl_oz numeric`
- **Backfill** each tap from the old per-recipe settings:
  `update tap_assignments t set swap_variation_id = s.swap_variation_id,
   swap_volume_fl_oz = s.swap_volume_fl_oz from taproom_recipe_settings s
   where s.recipe_id = t.recipe_id`.
- `alter table taproom_recipe_settings drop column swap_variation_id, drop column
  swap_volume_fl_oz` (leaves `is_retired` / retirement fields, which stay per-beer).

Having the same recipe on two taps means the swap config is stored twice, once per
tap. This is intentional and accepted — per-tap is the cleaner mental model and
removes cross-tap coupling.

**New deterministic shrinkage table** (option A):

```sql
create table public.draft_swap_shrinkage (
  source_ref      text primary key,          -- "sqtransfer:<orderId>:<lineUid>"
  recipe_id       uuid references public.recipes(id) on delete cascade,
  tap_number      int,
  occurred_at     timestamptz not null,
  remaining_fl_oz numeric not null,          -- beer left in keg at swap
  full_fl_oz      numeric not null,          -- recount target (for pct)
  created_at      timestamptz not null default now()
);
create index draft_swap_shrinkage_recipe_idx on public.draft_swap_shrinkage(recipe_id);
```

Keyed by `source_ref` so the sync upserts idempotently, matching how consumption
rows already reconcile per ref.

### 2. Consumption sync

**`lib/square/taproomConsumption.ts`**

- Delete the count-crossing block (the `for (const draft of draftLinks)` loop),
  the `restockRecipeIds` skip set, the `physicalCountsByVar` input, the
  `detectKegSwaps` import, and `DEFAULT_SWAP_VOLUME_FL_OZ`.
- Draft swaps come **only** from restock line items. Unmapped / unconfigured
  restocks still surface as `unmapped_restock` / `unconfigured_draft_swap`
  discrepancies — nothing is inferred.
- **Resolve swap config from the tap, not the recipe.** `deriveTaproomConsumption`
  loads `swap_variation_id` + `swap_volume_fl_oz` from `tap_assignments`
  (already selected for `restock_variation_id`). The restock unit's `variationId`
  and `recount.quantity` come from the tap row. `draftLinks` is retained solely
  to resolve the recount **target** (recipe → draft Square variation).
- `deriveTaproomConsumption` no longer fetches physical counts.

**`lib/production/taproomConsumptionSync.ts`**

- At the recount step (fires once, when `alreadyRecorded === 0`): **before**
  calling `setPhysicalCount(fullVolume)`, read the draft SKU's remaining fl oz and
  upsert a `draft_swap_shrinkage` row, then perform the recount. Remaining is read
  as the SKU's on-hand **as of `occurredAt`** (see Risk R1), then the recount
  overwrites it to full.
- Shrinkage capture is best-effort like the recount: a read/write failure is
  flagged as a discrepancy, never fatal, and does not block the shipment or
  deduction.

### 3. Deterministic shrinkage read

**`app/api/taproom/draft-stats/route.ts`**

- Remove `detectKegSwaps` / `detectKegEvents` / `fetchPhysicalCounts` usage.
- Build `shrinkage_by_recipe` by reading `draft_swap_shrinkage` within the window,
  grouped by `recipe_id`: `avg_shrinkage_fl_oz` = mean `remaining_fl_oz`,
  `avg_shrinkage_pct` = mean `remaining_fl_oz / full_fl_oz` (per-row full volume,
  fixing today's hardcoded 660), `keg_count` = row count, `events` = per-swap
  `{ date, shrinkage_fl_oz, shrinkage_pct }`.
- The response shape is unchanged, so `DraftStatsChart` and the Draft Shrinkage
  section render as-is.
- Extract the aggregation into a pure function in `lib/` (e.g.
  `lib/reports/draftShrinkage.ts`) with a co-located `*.test.ts`, per the
  modularity + coverage rules; the route stays a thin IO wrapper.

### 4. Configure Taps — all per tap

Replace the two-part UI (per-tap grid + bottom `DraftSwapInventorySection`) with a
single Configure Taps panel. Each **tap card** carries all selections, labeled:

- **Beer on this tap** — recipe dropdown.
- **Tap label (optional)**.
- **Square "Draft Restock" line** — restock variation dropdown → `restock_variation_id`
  (unchanged; restock-item picker + "Auto-match by tap #" stay in the panel header).
- **Cold-storage keg to drain on swap** — dropdown sourced from
  `GET /api/production/export-bay/inventory`, filtered to `container_type === "keg"`
  and this tap's `recipe_id`, shown as `1/6 Keg (12 available)`, value =
  `variation_id` (= `packaging_variations.id`) → `swap_variation_id`. Auto-selected
  when exactly one keg SKU is on hand. Inline **"needs a swap keg"** flag when the
  tap has a recipe but no keg set.
- **Full-keg volume — recount target** — numeric, auto-filled from the chosen lot's
  container volume, editable → `swap_volume_fl_oz`.

**Auto-map kegs** — panel header button mirroring "Auto-match by tap #": for every
tap with a recipe, fills the swap keg from that recipe's on-hand cold-storage kegs
(auto-picks the sole SKU; when several, picks the largest-volume and leaves it
overridable) and auto-fills volume. Never clobbers an existing manual pick.

`DraftSwapInventorySection` is deleted.

### 5. Save path

- Extend `PUT /api/taproom/tap-config` to accept `swap_variation_id` and
  `swap_volume_fl_oz` per tap in the `taps[]` payload and upsert them onto
  `tap_assignments` alongside `restock_variation_id`.
- Remove the `swap_variation_id` / `swap_volume_fl_oz` branches from
  `PATCH /api/production/taproom-recipe-settings` (it keeps only retirement).
  The draft-stats UI no longer calls it for swap config.

### 6. Deletions summary

- `lib/square/draftKegEvents.ts` + `lib/square/draftKegEvents.test.ts`.
- Count-crossing logic + `physicalCountsByVar` in `taproomConsumption.ts` (and its
  test cases).
- `DraftSwapInventorySection` in `DraftStatsTab.tsx`.
- Swap-config branches in `taproom-recipe-settings/route.ts`.
- Inferred shrinkage in `draft-stats/route.ts`.
- `swap_variation_id` / `swap_volume_fl_oz` columns on `taproom_recipe_settings`.

## Data migration plan

1. Apply the schema migration (add tap columns, backfill from
   `taproom_recipe_settings`, create `draft_swap_shrinkage`, drop old columns).
   Per repo policy, prod application happens only after explicit user OK + backup;
   the migration file is the source of truth.
2. No historical `draft_swap_shrinkage` backfill — the chart populates going
   forward from the next swaps. (Optional one-time backfill from existing physical
   counts is out of scope; call out if the empty-until-first-swap chart is a
   concern.)

## Testing

- `lib/square/taproomConsumption.test.ts` — drop crossing cases; keep/extend
  restock-only assembly (tap-grain swap config, discrepancies).
- `lib/production/taproomConsumptionSync.test.ts` — add shrinkage capture (reads
  remaining, upserts once, non-fatal on failure); recount still fires once.
- `lib/reports/draftShrinkage.test.ts` (new) — aggregation math (avg fl oz, pct
  per-row full volume, counts).
- Remove `lib/square/draftKegEvents.test.ts`.
- Keep `lib/` coverage above the `vitest.config.ts` threshold.

## Risks / open questions

- **R1 — remaining-fl-oz capture accuracy.** If draft pours decrement the Square
  SKU in real time, the naive "current count at sync time" under-reports remaining
  (new-keg pours between the ring and the sync run lower it). Capture must read the
  count **as of the restock order's `occurredAt`** — the last `PHYSICAL_COUNT` at
  or before `occurredAt` from history (`fetchPhysicalCounts`), falling back to
  `fetchCurrentCounts` only if no prior count exists. Confirm the actual Square
  change-type behavior for draft pours during planning/implementation before
  finalizing the read.
- **R2 — recount target when a beer is on two taps.** Both taps resolve the same
  recipe draft Square SKU and recount it to full; that mirrors current behavior and
  is acceptable given one draft SKU per beer.
- **R3 — dropped `taproom_recipe_settings` columns.** Verify no other reader
  references them before dropping (grep shows only the swap path).

## Rollout

1. Migration (gated on user OK + backup for prod).
2. Sync + lib changes with tests.
3. draft-stats read swap.
4. Configure Taps UI + tap-config PUT + taproom-recipe-settings trim.
5. Delete dead code.
