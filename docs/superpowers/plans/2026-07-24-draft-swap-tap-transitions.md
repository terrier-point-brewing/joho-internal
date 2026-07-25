# Draft Swap Tap Transitions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a beer-changing draft swap book both sides correctly — write off the outgoing keg's residual as shrinkage against the outgoing beer, zero it in Square, deduct and recount the incoming beer — driven by a frozen swap record that later config edits cannot alter.

**Execution Budget:** Execute **inline** (`superpowers:executing-plans`) per the CLAUDE.md tier table — 9 files across 4 locality groups (migration · `lib/` sync path · API routes · UI). The writing-plans "subagent-driven (recommended)" stamp is overridden. `Spawn cap = 4 + 2 = 6`; inline execution should use **0**. Token target ≈ 120k.

**Architecture:** A new `tap_swap_transitions` table stores a frozen snapshot of both sides of a tap's beer change, opened by an explicit **Swap keg** action on the Draft Stats tap card. The taproom-consumption sync pairs pending transitions to Draft Restock line events in FIFO order (pure logic), then claims each with a conditional `UPDATE … WHERE consumed_source_ref IS NULL` — the atomic once-only guard — before booking the outgoing side. `tap_assignments` is untouched until the ring, so the card keeps showing what is physically pouring.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase Postgres (PostgREST), Vitest, TanStack Query, Tailwind v4 tokens.

**Spec:** `docs/superpowers/specs/2026-07-24-draft-swap-tap-transition-design.md`

## Global Constraints

- **Migration `20260816_tap_swap_transitions.sql` is HUMAN-GATED.** Never apply it to prod. Deploying any task past Task 4 before it is applied **500s both the taproom sync and `/api/taproom/draft-stats`**, because both query the new table. This is a hard deploy gate — flag it in the PR body.
- **No PostgREST embeds on `tap_swap_transitions`.** It has two FKs to `recipes` (`from_recipe_id`, `to_recipe_id`). Constraint-name-disambiguated embeds have crashed this codebase with PGRST200 before (prod FK names are non-canonical). Load beer/variation names with separate `recipes` / `packaging_variations` queries and join client-side.
- **`assembleConsumption` stays pure.** No IO, no clock. Time-dependent behavior takes an explicit `nowIso` parameter.
- **Volumes are never client-supplied.** `to_volume_fl_oz` is resolved server-side from `packaging_variations.total_volume_fl_oz`.
- **UI**: token utilities only (no `zinc-*`/`amber-*`/hex); `.btn-secondary btn-xxs` for card actions; `<Modal>`/`<Field>`/`<ModalActions>` from `app/components/ui/Modal.tsx`; `<Badge tone>` from `app/components/ui/Badge.tsx`. Per `docs/UI_STANDARD.md`.
- **Every `lib/` module ships a co-located `*.test.ts`.** Don't drop coverage below the `vitest.config.ts` floor.
- **Per-task DoD:** `npm run verify` passes (lint + typecheck + tests).
- Square API version `2025-04-16`; single location `LZ8TH4A632YW0`.

---

### Task 1: Migration — `tap_swap_transitions`

**Files:**
- Create: `supabase/migrations/20260816_tap_swap_transitions.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: table `public.tap_swap_transitions` with the column set below; indexes `tap_swap_transitions_pending_idx`, `tap_swap_transitions_source_ref_key`.

Columns (types exactly as listed): `id uuid pk default gen_random_uuid()`, `tap_number int not null`, `from_recipe_id uuid null → recipes(id) on delete set null`, `from_variation_id uuid null → packaging_variations(id) on delete set null`, `from_volume_fl_oz numeric null`, `from_draft_square_variation_id text null`, `to_recipe_id uuid not null → recipes(id) on delete cascade`, `to_variation_id uuid not null → packaging_variations(id) on delete cascade`, `to_volume_fl_oz numeric not null`, `to_draft_square_variation_id text null`, `retire_outgoing boolean not null default false`, `opened_at timestamptz not null default now()`, `consumed_source_ref text null`, `consumed_at timestamptz null`, `created_at timestamptz not null default now()`.

- [ ] **Step 1: Write the migration**

Two indexes carry the semantics — both partial, and both required:

```sql
create index if not exists tap_swap_transitions_pending_idx
  on public.tap_swap_transitions (tap_number, opened_at)
  where consumed_source_ref is null;

create unique index if not exists tap_swap_transitions_source_ref_key
  on public.tap_swap_transitions (consumed_source_ref)
  where consumed_source_ref is not null;
```

RLS: enable, plus one policy `tap_swap_transitions_authenticated_all for all to authenticated using (true) with check (true)` — matching `tap_assignments` and `draft_pour_consumption`.

Add a table comment explaining that `from_*` is nullable because a transition may fill a previously empty tap, and that `retire_outgoing` is true only when *this* transition flipped `is_retired`.

- [ ] **Step 2: Verify it parses**

Run: `npx supabase db lint --file supabase/migrations/20260816_tap_swap_transitions.sql` — if the CLI is unavailable, review by eye against `supabase/migrations/20260727_draft_pour_consumption.sql` for house style.
Expected: no syntax errors.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260816_tap_swap_transitions.sql
git commit -m "feat(db): tap_swap_transitions table for draft beer-change swaps"
```

---

### Task 2: Extract the retire payload helper

The swap route must set `is_retired` without an HTTP call to another route. Extract the payload construction currently inlined at `app/api/production/taproom-recipe-settings/route.ts:33-38` so both callers share it.

**Files:**
- Create: `lib/taproom/retireRecipe.ts`
- Create: `lib/taproom/retireRecipe.test.ts`
- Modify: `app/api/production/taproom-recipe-settings/route.ts:28-38`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface RetirePayload {
    recipe_id: string; updated_at: string;
    is_retired: boolean; retired_at: string | null; retired_notes: string | null;
  }
  export function buildRetirePayload(
    recipeId: string, isRetired: boolean, nowIso: string, notes?: string | null,
  ): RetirePayload;
  ```

- [ ] **Step 1: Write the failing tests**

Cases: retiring sets `retired_at = nowIso`; un-retiring sets `retired_at = null`; `notes` passthrough; empty-string notes → `null`; omitted notes → `null`; `updated_at` always `nowIso`.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run lib/taproom/retireRecipe.test.ts`
Expected: FAIL — cannot resolve `./retireRecipe`.

- [ ] **Step 3: Implement `buildRetirePayload`**

Pure, no clock — the caller passes `nowIso`. Preserve the existing semantics exactly: `retired_at` mirrors `is_retired`, `retired_notes` falls back to `null` on any falsy value.

- [ ] **Step 4: Rewire the settings route**

Hoist a single `const now = new Date().toISOString()`, seed `payload` with `{ recipe_id, updated_at: now }`, and inside the existing `if ("is_retired" in body)` branch `Object.assign(payload, buildRetirePayload(recipe_id, Boolean(body.is_retired), now, body.retired_notes))`. The "only upsert fields the caller sent" behavior must not change.

- [ ] **Step 5: Verify**

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/taproom/retireRecipe.ts lib/taproom/retireRecipe.test.ts app/api/production/taproom-recipe-settings/route.ts
git commit -m "refactor(taproom): extract shared retire payload helper"
```

---

### Task 3: Pure FIFO pairing — `lib/taproom/tapSwaps.ts`

**Files:**
- Create: `lib/taproom/tapSwaps.ts`
- Create: `lib/taproom/tapSwaps.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface PendingTapSwap {
    id: string; tapNumber: number;
    fromRecipeId: string | null; fromBeerName: string | null;
    fromVariationId: string | null; fromVolumeFlOz: number | null;
    fromDraftSquareVariationId: string | null;
    toRecipeId: string; toBeerName: string;
    toVariationId: string; toVolumeFlOz: number;
    toDraftSquareVariationId: string | null;
    openedAt: string;
  }

  /** Stable key for a restock line event. */
  export function restockEventKey(orderId: string, lineUid: string): string;

  /**
   * Pair queued swaps to restock events per tap, FIFO.
   * Returns restockEventKey → the swap that event consumes.
   */
  export function pairSwapsToRestocks(
    events: { orderId: string; lineUid: string; squareVariationId: string; occurredAt: string }[],
    tapByRestockVariation: Map<string, number>,
    pending: PendingTapSwap[],
  ): Map<string, PendingTapSwap>;

  /** Queued swaps older than `maxAgeDays` that no event in this window consumed. */
  export function staleSwaps(
    pending: PendingTapSwap[], paired: Map<string, PendingTapSwap>,
    nowIso: string, maxAgeDays: number,
  ): PendingTapSwap[];
  ```

- [ ] **Step 1: Write the failing tests**

`pairSwapsToRestocks`: one event + one swap on a tap pairs; two events + one swap → only the **earliest** event pairs; one event + two swaps → the **oldest** swap pairs; swaps on tap 3 never pair with events on tap 5; an event whose `squareVariationId` is absent from `tapByRestockVariation` pairs with nothing; equal `occurredAt`/`openedAt` values break ties deterministically (by `lineUid` / `id`) so repeated runs agree; empty inputs return an empty map.

`staleSwaps`: a 10-day-old unpaired swap is stale at `maxAgeDays: 7`; a 10-day-old **paired** swap is not; a 2-day-old unpaired swap is not.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run lib/taproom/tapSwaps.test.ts`
Expected: FAIL — cannot resolve `./tapSwaps`.

- [ ] **Step 3: Implement**

Non-obvious part — the zip must be per-tap and deterministic:

```ts
const eventsByTap = new Map<number, typeof events>();   // sorted by (occurredAt, lineUid)
const swapsByTap  = new Map<number, PendingTapSwap[]>(); // sorted by (openedAt, id)
// then for each tap: zip index-wise, stopping at the shorter list
```

Ties must fall back to the secondary key — without it, two runs can pair differently and double-book.

- [ ] **Step 4: Run tests**

Run: `npx vitest run lib/taproom/tapSwaps.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/taproom/tapSwaps.ts lib/taproom/tapSwaps.test.ts
git commit -m "feat(taproom): pure FIFO pairing of queued swaps to restock events"
```

---

### Task 4: Derive transition-bound consumption units

**Files:**
- Modify: `lib/square/taproomConsumption.ts` (`ConsumptionUnit`, `AssemblyDiscrepancy`, `assembleConsumption`, `deriveTaproomConsumption`)
- Modify: `lib/square/taproomConsumption.test.ts`

**Interfaces:**
- Consumes: `PendingTapSwap`, `pairSwapsToRestocks`, `restockEventKey`, `staleSwaps` from Task 3.
- Produces:
  - `ConsumptionUnit` gains `swap?: PendingTapSwap` — set when this restock consumes a queued swap.
  - `AssemblyDiscrepancy` gains `{ kind: "stale_queued_swap"; tapNumber: number; swapId: string; openedAt: string; toBeerName: string }`.
  - `assembleConsumption` input gains `pendingSwaps?: PendingTapSwap[]` and `nowIso?: string` (staleness only emitted when `nowIso` is given).

- [ ] **Step 1: Write the failing tests**

In `taproomConsumption.test.ts`: a restock event paired to a swap yields a unit whose `recipeId`/`variationId` come from the swap's `to_*` (**not** the tap row), whose `recount.squareVariationId` is `toDraftSquareVariationId` and `recount.quantity` is `toVolumeFlOz`, whose `label` names the **incoming** beer, and which carries `swap`. An unpaired event still resolves off `TapRestockLink` exactly as today (assert the existing tests still pass untouched). A paired swap with `toDraftSquareVariationId: null` yields `recount: undefined` but still a unit. A stale unpaired swap emits `stale_queued_swap` when `nowIso` is supplied, and nothing when it is omitted.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run lib/square/taproomConsumption.test.ts`
Expected: FAIL — `pendingSwaps` not accepted / `swap` undefined on units.

- [ ] **Step 3: Extend `assembleConsumption`**

Build `tapByRestockVariation` from `tapRestockLinks`, call `pairSwapsToRestocks`, then inside the existing restock loop resolve each of `recipeId` / `variationId` / `volumeFlOz` / draft SKU / beer name from the swap when one is paired, else from the link. The `unconfigured_draft_swap` guard now tests the **resolved** variation + volume, and keys its discrepancy on the resolved recipe. Append `staleSwaps(...)` output as discrepancies when `nowIso` is present.

- [ ] **Step 4: Load pending swaps in `deriveTaproomConsumption`**

Plain select on `tap_swap_transitions` — `.is("consumed_source_ref", null).order("opened_at")` — with **no embeds** (see Global Constraints). Collect `from_recipe_id` + `to_recipe_id`, fetch `recipes(id, beer_name)` with a single `.in("id", ids)`, and map names in. Pass `pendingSwaps` and `nowIso: new Date().toISOString()` into `assembleConsumption`.

- [ ] **Step 5: Run tests**

Run: `npm run verify`
Expected: PASS — including every pre-existing `taproomConsumption` test.

- [ ] **Step 6: Commit**

```bash
git add lib/square/taproomConsumption.ts lib/square/taproomConsumption.test.ts
git commit -m "feat(taproom): resolve restock units from queued swap transitions"
```

---

### Task 5: Book the outgoing side in the sync

**Files:**
- Modify: `lib/production/taproomConsumptionSync.ts` (`SyncDiscrepancy`, the `for (const u of units)` body around lines 140-239)
- Modify: `lib/production/taproomConsumptionSync.test.ts` (extend `fakeSupabase`, add cases)

**Interfaces:**
- Consumes: `ConsumptionUnit.swap` from Task 4; `buildRetirePayload` from Task 2; `setPhysicalCount` / `fetchCurrentCounts` from `lib/square/inventory.ts`.
- Produces: `SyncDiscrepancy` gains `{ kind: "multi_tap_outgoing_skipped"; tapNumber: number; recipeId: string; beerName: string | null }` — nullable because it is sourced from `PendingTapSwap.fromBeerName`. `TaproomSyncResult` gains `swapsConsumed: number`.

- [ ] **Step 1: Write the failing tests**

Extend `fakeSupabase` so `from("tap_swap_transitions")` supports the conditional-claim chain (`.update().eq().is().select()`, returning a configurable claimed/not-claimed result) and `from("tap_assignments")` captures the flip + answers the "outgoing beer on another tap" count. Cases:

1. A swap unit whose claim succeeds writes a `draft_swap_shrinkage` row with `recipe_id = fromRecipeId` and `full_fl_oz = fromVolumeFlOz`, and calls `setPhysicalCount(fromDraftSquareVariationId, 0, …)`.
2. It also calls `setPhysicalCount(toDraftSquareVariationId, toVolumeFlOz, …)` — the incoming recount still fires.
3. It flips `tap_assignments` for that tap to the `to_*` values and clears `is_retired` on `toRecipeId`.
4. **Claim loses** (no rows returned): no shrinkage row, no zeroing, no flip, no un-retire — but the incoming deduction/recount path is unaffected.
5. **Multi-tap guard**: outgoing recipe still present on another tap → no shrinkage, no zeroing, and a `multi_tap_outgoing_skipped` discrepancy; the flip and incoming recount still happen.
6. `fromRecipeId: null` (empty tap gaining a beer) → no outgoing work, no discrepancy.
7. `fromDraftSquareVariationId: null` → no zeroing, warning emitted, incoming side unaffected.
8. A `setPhysicalCount` failure on the outgoing zeroing yields `shrinkage_capture_failed` and does **not** throw or block the incoming recount.
9. `alreadyRecorded > 0` → the swap block never runs (fire-once).
10. A non-swap `draft_swap` unit keeps today's behavior — capture on `u.recount.squareVariationId` (assert existing tests unchanged).
11. A paired swap unit with `quantity: 2` deducts 2 of the incoming keg (one `recordTaproomConsumption` call with `quantity: 2`) while the outgoing side still runs exactly once.
12. `swapsConsumed` counts successful claims — 1 for a won claim, 0 for a lost one.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run lib/production/taproomConsumptionSync.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement the swap block**

Place it after `recordTaproomConsumption` and gate it identically to the existing recount, so a unit that books nothing never claims:

```ts
if (u.swap && alreadyRecorded === 0 && res.recordedQty + res.shortfallQty > EPS) {
  const { data: claimed, error } = await supabase
    .from("tap_swap_transitions")
    .update({ consumed_source_ref: u.sourceRef, consumed_at: new Date().toISOString() })
    .eq("id", u.swap.id)
    .is("consumed_source_ref", null)   // ← the atomic claim
    .select("id");
  if (error) throw new Error(`swap claim failed: ${error.message}`);
  if ((claimed ?? []).length > 0) { /* flip → guard → outgoing side */ }
}
```

Order inside the claim: (a) flip `tap_assignments` to `to_*`; (b) un-retire `toRecipeId` via `buildRetirePayload(toRecipeId, false, now)`; (c) count `tap_assignments` rows still holding `fromRecipeId` — if zero, capture the outgoing residual with `fetchCurrentCounts` then `setPhysicalCount(fromSku, 0, occurredAt)`; if non-zero, emit `multi_tap_outgoing_skipped`. The guard must run **after** the flip, or the tap being swapped counts itself.

Then change the existing shrinkage capture to skip when `u.swap` is set — for a swap, the residual on the *incoming* SKU is meaningless. The incoming `setPhysicalCount` is unchanged.

- [ ] **Step 4: Run tests**

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/production/taproomConsumptionSync.ts lib/production/taproomConsumptionSync.test.ts
git commit -m "feat(taproom): book outgoing side of a beer-change draft swap"
```

---

### Task 6: Queue / cancel API + `queued_swap` on draft-stats

**Files:**
- Create: `app/api/taproom/tap-swaps/route.ts`
- Modify: `app/api/taproom/draft-stats/route.ts`
- Modify: `lib/query-keys.ts` (add `taproom.tapSwaps()`)

**Interfaces:**
- Consumes: `buildRetirePayload` (Task 2); the `tap_swap_transitions` table (Task 1).
- Produces:
  - `POST /api/taproom/tap-swaps` body `{ tap_number: number; to_recipe_id: string; to_variation_id: string; retire_outgoing?: boolean }` → `201 { id }`.
  - `DELETE /api/taproom/tap-swaps?id=<uuid>` → `{ ok: true }`.
  - `GET /api/taproom/draft-stats` taps gain `queued_swap: { id, to_recipe_id, to_beer_name, to_variation_name, opened_at } | null`.
  - `queryKeys.taproom.tapSwaps = () => ["taproom", "tap-swaps"] as const`.

- [ ] **Step 1: Implement POST**

Use `requireDateRange`-style discipline from `lib/utils/api.ts` — validate explicitly and wrap failures in `apiError()`. Sequence: snapshot `from_*` from `tap_assignments` for the tap (plus that recipe's `packaging = "draft"` row in `recipe_square_links` for `from_draft_square_variation_id`); resolve `to_volume_fl_oz` from `packaging_variations.total_volume_fl_oz` (**400** if null — a keg with no coded volume cannot be a recount target) and `to_draft_square_variation_id` from the incoming recipe's draft link; **409** if a pending transition already exists for this tap; read `taproom_recipe_settings.is_retired` for the outgoing recipe; insert with `retire_outgoing = Boolean(retire_outgoing) && !!from_recipe_id && !alreadyRetired`. Only when that resolves true, upsert `buildRetirePayload(from_recipe_id, true, now)` — failure here is reported as a `warning` in the response body, never fatal (the insert is the write that must not be lost).

- [ ] **Step 2: Implement DELETE**

Load the transition (**404** missing, **409** if `consumed_source_ref` is not null — a consumed swap is history). When `retire_outgoing` is true and `from_recipe_id` is present, upsert `buildRetirePayload(from_recipe_id, false, now)` first, then delete the row. `retire_outgoing = false` must **not** un-retire — the beer was already retired before this swap.

- [ ] **Step 3: Add `queued_swap` to draft-stats**

Add a pending-transitions query to the existing `Promise.all` at `app/api/taproom/draft-stats/route.ts:18`. Resolve incoming beer names via a separate `recipes` `.in("id", …)` lookup and variation names via `packaging_variations` — **no embeds**. Attach per tap in both the `emptyTaps` early-return path (line 47) and `enrichedTaps` (line 97); a tap with no pending transition gets `null`.

- [ ] **Step 4: Verify**

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 5: Manual smoke via the dev server**

Start the preview, then confirm `GET /api/taproom/draft-stats` returns `queued_swap: null` for every tap and that a `POST` to `/api/taproom/tap-swaps` with a bogus `to_variation_id` returns 400 rather than 500.

- [ ] **Step 6: Commit**

```bash
git add app/api/taproom/tap-swaps/route.ts app/api/taproom/draft-stats/route.ts lib/query-keys.ts
git commit -m "feat(taproom): queue/cancel tap swap API + queued_swap on draft-stats"
```

---

### Task 7: Swap keg action on the Draft Stats tap card

**Files:**
- Modify: `app/taproom/components/DraftStatsTab.tsx`

**Interfaces:**
- Consumes: the Task 6 endpoints; `queryKeys.taproom.tapSwaps()`; existing `kegOptionsByRecipe` (line 173), `draftRecipes` (line 223), `codedVolumeFor` (line 188).
- Produces: no new exports.

- [ ] **Step 1: Extend the local types**

`TapRow` gains `queued_swap: { id, to_recipe_id, to_beer_name, to_variation_name, opened_at } | null`.

- [ ] **Step 2: Add the Swap keg action**

A `.btn-secondary btn-xxs` button on each **assigned** tap card in non-editing mode, beside the existing Mark Retired button (line 686). Render it on retired/greyed cards too — a retired tap at critical is exactly the tap that wants a swap queued. Hidden when the tap already has a `queued_swap`.

- [ ] **Step 3: Build the confirm modal**

`<Modal title="Swap keg — Tap N">` with `<Field>` rows and `<ModalActions label="Queue swap">`:
- **Incoming beer** — `.inp text-xs`, options from `draftRecipes`.
- **Keg to drain** — `.inp text-xs`, options from `kegOptionsByRecipe.get(incomingRecipeId)` with the existing `(N on hand)` hint; disabled until a beer is picked.
- **Full-keg volume** — read-only text from `codedVolumeFor(pick)`, never an input.
- **Write-off notice** — `Writing off ~{tap.metrics.current_fl_oz} fl oz of {tap.beer_name}`. Read straight from the existing metrics; this is already Square's calculated on-hand for that draft SKU, so **no extra fetch**.
- **"Also retire {tap.beer_name}"** — checkbox, **pre-checked**, rendered only when the outgoing recipe appears on no other tap in `stats.taps`.

Submit POSTs to `/api/taproom/tap-swaps`, then invalidates `queryKeys.taproom.draftStats()` and `queryKeys.taproom.tapConfig()`. Surface errors with `<Banner>`, not `alert()`.

- [ ] **Step 4: Add the queued badge + cancel**

On a tap with `queued_swap`, render `<Badge tone="info">→ {to_beer_name} queued</Badge>` plus a `.btn-secondary btn-xxs` Cancel that DELETEs and invalidates the same keys. The card otherwise keeps showing the **outgoing** beer and its real metrics — that is the whole point of not touching `tap_assignments` at queue time.

- [ ] **Step 5: Verify**

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 6: Browser verification**

Open the preview at Taproom → Performance → Draft Stats. Confirm: the Swap keg button renders on assigned taps; the modal's volume field is read-only and populates on keg selection; the write-off figure matches the card's `fl oz avail`; queueing a swap leaves the card on the old beer with a queued badge; Cancel clears it. Check `read_console_messages` for errors and screenshot the queued state.

- [ ] **Step 7: Commit**

```bash
git add app/taproom/components/DraftStatsTab.tsx
git commit -m "feat(taproom): Swap keg action + queued badge on Draft Stats"
```

---

## Acceptance criteria (whole branch)

1. Queueing a swap on tap N inserts one `tap_swap_transitions` row, retires the outgoing beer only if it was not already retired, and leaves `tap_assignments` unchanged.
2. The tap card keeps showing the outgoing beer with its real metrics plus a badge naming the incoming beer, until the ring.
3. The Draft Restock ring for tap N: writes one `draft_swap_shrinkage` row against the **outgoing** recipe with the **outgoing** keg's `full_fl_oz`; zeroes the outgoing draft SKU in Square; deducts `ev.quantity` of the **incoming** keg from cold storage; sets the incoming draft SKU to `to_volume_fl_oz`; clears `is_retired` on the incoming recipe; flips `tap_assignments`.
4. Re-running the sync over the same window changes nothing — the claim and the `alreadyRecorded` gate both hold.
5. When the outgoing beer is still on another tap, no zeroing or shrinkage occurs and a `multi_tap_outgoing_skipped` discrepancy is reported.
6. A restock with no queued transition behaves exactly as before this branch.
7. Cold storage short on the incoming keg still books a phantom export.
8. `npm run verify` green.

## Out of scope (from the spec)

Amending swaps already booked wrong (no reversal path); distinguishing two taps of the same beer; ring-first recovery; auto-expiring stale transitions.
