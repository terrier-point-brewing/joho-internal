# Draft swap: tap transitions that survive a beer change

**Date:** 2026-07-24
**Area:** Taproom → Performance → Draft Stats; taproom-consumption sync

## Problem

A Draft Restock ring is a **point-in-time fact** ("tap 3's keg was changed at
4:12pm"), but it is resolved against **mutable current-state config**. In
`assembleConsumption` (`lib/square/taproomConsumption.ts:140`) a restock line
looks up `tap_assignments` by `restock_variation_id` and reads whatever
`recipe_id` / `swap_variation_id` / `swap_volume_fl_oz` are in that row *at sync
time*. Three separate outcomes hang off that single mutable read:

- which beer's keg is deducted from cold storage,
- which draft SKU is recounted to full in Square,
- which recipe the `draft_swap_shrinkage` row is attributed to.

`tap_assignments` is keyed by `tap_number` with no history
(`supabase/migrations/20260612_tap_assignments.sql`), so there is no way to ask
"what was on tap 3 at 4:12pm."

Taps are reconfigured **before** the bartender rings (confirmed workflow), so the
wrong-keg deduction is not the live failure. What *does* fail is that a
beer-changing swap involves **two recipes** and the model can only express one:

1. **The outgoing beer's draft SKU is never zeroed.** Beer A keeps its leftover
   fl oz in Square forever, off every tap, silently inflating draft on-hand in
   Draft Stats and `/api/production/taproom-inventory`.
2. **The outgoing keg's shrinkage is lost.** The capture at
   `lib/production/taproomConsumptionSync.ts:193` reads
   `u.recount.squareVariationId`, which by then is *Beer B's* SKU. The
   `remaining_fl_oz` value is meaningless and is filed under Beer B.

Confirmed operational context: when a tap's beer changes, the outgoing keg is
**pulled early and the remaining beer is dumped** — a real loss that belongs in
shrinkage against the outgoing recipe.

## Goal

Make a beer-changing draft swap book both sides correctly: write off the
outgoing keg's residual as shrinkage against the **outgoing** beer, zero that
beer in Square, deduct a keg of the **incoming** beer, and recount the incoming
beer to full — driven by a record of the swap that later config edits cannot
alter.

Like-for-like restocks (same beer, fresh keg) keep today's behavior unchanged.

## Constraints & decisions (from brainstorming)

- **Config-first workflow is reliable.** Taps are reconfigured in the app before
  the restock line is rung. The design assumes it and does not try to recover
  from ring-first.
- **A config edit is not always a swap.** Corrections happen (rarely). Intent is
  therefore captured by *which action the operator took*, not by diffing a save:
  a dedicated **Swap keg** action opens a transition; **Configure Taps** stays a
  pure correction path that never opens one.
- **The swap note is frozen at open time.** Both sides — recipes, packaging
  variations, coded volumes, and Square draft SKU ids — are snapshotted. Nothing
  about booking a swap may depend on state editable between the swap and the ring.
- **Volumes are never client-supplied.** `to_volume_fl_oz` is resolved server-side
  from the packaging variation's coded `total_volume_fl_oz`, matching the rule
  `DraftStatsTab.tsx:187` already enforces.
- **The tap card keeps showing the outgoing beer until the ring.** A queued swap
  renders as a badge naming the incoming recipe. `tap_assignments` is *not*
  updated at queue time — the ring flips it. This keeps the display matching what
  is physically pouring even when a rotation is planned a day ahead.
- **Retire fires at queue time; un-retire fires at ring time.** Retiring is a
  decision already made when the swap is queued, so batch-scheduler should stop
  suggesting the outgoing beer immediately. This lands exactly on the behavior
  `app/taproom/components/categoryStyles.ts:8` encodes — a retired tap keeps
  normal coloring while it still has beer and only greys out at critical
  ("meant to blow, not be reordered"). A queued swap *is* a keg being blown down
  on purpose.
- **Retire never suppresses accounting.** A retired beer's residual is still
  dumped and still recorded as shrinkage. Retire changes planning, not accounting.

## Data model

New table, migration `supabase/migrations/20260816_tap_swap_transitions.sql`:

```
tap_swap_transitions
  id                              uuid pk
  tap_number                      int not null
  from_recipe_id                  uuid null → recipes(id) on delete set null
  from_variation_id               uuid null → packaging_variations(id) on delete set null
  from_volume_fl_oz               numeric null
  from_draft_square_variation_id  text null
  to_recipe_id                    uuid not null → recipes(id)
  to_variation_id                 uuid not null → packaging_variations(id)
  to_volume_fl_oz                 numeric not null
  to_draft_square_variation_id    text null
  retire_outgoing                 boolean not null default false  -- true only if THIS transition flipped the flag
  opened_at                       timestamptz not null default now()
  consumed_source_ref             text null      -- null = pending
  consumed_at                     timestamptz null
  created_at                      timestamptz not null default now()
```

Indexes carry the semantics:

- partial index on `(tap_number, opened_at) where consumed_source_ref is null` —
  FIFO lookup of pending transitions;
- partial **unique** on `(consumed_source_ref) where consumed_source_ref is not null`
  — one restock ring can never be claimed by two transitions.

RLS: `for all to authenticated using (true) with check (true)`, matching
`tap_assignments` and `draft_pour_consumption`.

`from_*` columns are nullable because a transition may fill a previously empty
tap (no outgoing side).

## Lifecycle

### Queue — `POST /api/taproom/tap-swaps`

Body: `{ tap_number, to_recipe_id, to_variation_id, retire_outgoing }`.

The route:

1. Reads the current `tap_assignments` row for the tap and that recipe's draft
   Square link, snapshotting the `from_*` side.
2. Resolves `to_volume_fl_oz` from `packaging_variations.total_volume_fl_oz` and
   `to_draft_square_variation_id` from the incoming recipe's draft link.
3. Inserts the transition.
4. When the caller asked to retire and `from_recipe_id` is present **and the
   outgoing recipe was not already retired**, sets
   `taproom_recipe_settings.is_retired` (+ `retired_at`) and persists
   `retire_outgoing = true` on the transition. If the beer was already retired,
   `retire_outgoing` stays `false` so a later cancel cannot un-retire something
   this swap did not retire.

   The `is_retired` write must not be an HTTP call to
   `/api/production/taproom-recipe-settings`. Extract that route's payload
   construction (`is_retired` + `retired_at` + `retired_notes`) into a small
   `lib/taproom/` helper and have both callers use it, per the
   shared-logic-in-one-place rule.

Step 3 must succeed; step 4 is reported as a warning on failure — a transition
without the retire flag is recoverable via the existing Mark Retired button, the
reverse is not.

`tap_assignments` is **not** touched here.

### Pending

The transition is visible on the tap card until a ring consumes it. Cancel
(`DELETE /api/taproom/tap-swaps?id=`) deletes the transition and un-retires the
outgoing recipe only when `retire_outgoing = true`. Since `tap_assignments` was
never touched at queue time, there is no assignment to revert.

The sync emits a `stale_queued_swap` discrepancy for transitions pending more
than 7 days, so a queued swap that never gets rung surfaces instead of silently
attaching to a much later ring.

### Consume — the restock ring

`deriveTaproomConsumption` loads pending transitions and passes them to
`assembleConsumption`, which pairs them to restock events **per tap in FIFO
order** (events by `occurred_at`, transitions by `opened_at`). Pairing is pure
and testable; the DB claim below is purely the concurrency guard.

A paired unit carries the transition on a new optional field, and takes its
`recipeId` / `variationId` / recount target from the transition's `to_*` side
rather than the tap row. Unpaired restock events resolve off current config
exactly as today.

In `runTaproomConsumptionSync`, for a unit carrying a transition:

1. **Claim** — `UPDATE tap_swap_transitions SET consumed_source_ref = $ref,
   consumed_at = now() WHERE id = $id AND consumed_source_ref IS NULL RETURNING id`.
   The conditional update *is* the atomic claim. This matters because the Square
   webhook fires this sync on every `order.*` event, so one restock produces a
   burst of overlapping runs — the same hazard the lease lock
   (`taproomConsumptionSync.ts:74`) exists for. The claim makes the old-side
   writes safe independently of the lock. No rows returned → another run already
   handled the old side; skip to step 4.
2. **Outgoing side** (only when the multi-tap guard below permits): read the
   outgoing draft SKU via `fetchCurrentCounts`, upsert `draft_swap_shrinkage`
   with `recipe_id = from_recipe_id`, `full_fl_oz = from_volume_fl_oz`,
   `remaining_fl_oz` = that reading; then `setPhysicalCount(fromSku, 0, occurredAt)`.
   Read before write. Best-effort — failures become `shrinkage_capture_failed`
   discrepancies, never fatal, matching existing behavior.
3. **Flip the tap** — update `tap_assignments` for this tap to the transition's
   `to_*` values, and clear `is_retired` on `to_recipe_id`.
4. **Incoming side** — unchanged code path: `recordTaproomConsumption` deducts
   `ev.quantity` of `to_variation_id`, then `setPhysicalCount(toSku,
   to_volume_fl_oz)`. Still gated on `alreadyRecorded === 0` and still falls back
   to a phantom export when cold storage is short.

Step 2's shrinkage row keeps `source_ref` as its primary key, so a swap still
produces exactly one shrinkage row per ring. Its `recipe_id` shifts meaning from
"the beer restocked" to "the beer that lost the volume" — which is what the
chart wants, and the two coincide for like-for-like swaps, so the Draft
Shrinkage chart needs no change.

## Multi-tap guard (important)

The draft SKU is **per recipe**, not per tap. If the outgoing beer is still on
another tap after the swap, its SKU count is the *combined* level across both
taps. Zeroing it would wipe the other tap's beer, and the residual reading would
be wrong.

So the outgoing-side work in step 2 runs **only when the outgoing recipe is on no
other tap** after the flip. Otherwise it is skipped and a
`multi_tap_outgoing_skipped` discrepancy is emitted naming the tap and recipe.
The same condition gates the pre-checked state of the retire checkbox in the UI.

This is a pre-existing modelling limit — the same reason `byRecipe` in
`app/api/taproom/draft-stats/route.ts:65` aggregates two taps of one beer into a
single metric — and is documented, not fixed, here.

## UI — Draft Stats tap card

- **Swap keg** action on each assigned tap card (non-editing mode), beside
  Mark Retired. Present on retired/greyed cards too: a retired tap at critical is
  exactly the tap that wants a swap queued.
- **Confirm modal** (`<Modal>` / `<ModalActions>` / `<Field>` per
  `docs/UI_STANDARD.md`):
  - incoming beer — draft-linked recipes, same source as the existing
    `draftRecipes` list;
  - keg to drain — that recipe's keg variations with on-hand hints, reusing
    `kegOptionsByRecipe`;
  - full-keg volume — read-only, from the variation's coded fl oz;
  - **"Writing off ~N fl oz of {outgoing beer}"** — read straight from
    `tap.metrics.current_fl_oz`, which is already Square's calculated on-hand for
    that draft SKU. No extra fetch.
  - **"Also retire {outgoing beer}"** — pre-checked, shown only when the outgoing
    beer will be on no other tap.
- **Queued badge** on the card: `<Badge>` reading `→ {incoming beer} queued`,
  plus a Cancel action. Card otherwise keeps showing the outgoing beer and its
  real metrics.
- `GET /api/taproom/draft-stats` gains a per-tap
  `queued_swap: { id, to_recipe_id, to_beer_name, to_variation_name, opened_at } | null`.

## Edge cases

| Case | Behavior |
| --- | --- |
| Empty tap gains a beer | `from_*` null → no shrinkage, no zeroing, no retire; deduct + recount only |
| Outgoing recipe has no draft Square link | Skip shrinkage + zeroing, emit a warning; incoming side proceeds |
| Incoming recipe has no draft Square link | `recount: undefined`, as today; outgoing side still runs |
| Outgoing beer still on another tap | Outgoing side skipped, `multi_tap_outgoing_skipped` discrepancy (see guard above) |
| `ev.quantity > 1` on a paired ring | Transition covers the beer-change accounting once; deduction stays `ev.quantity` of the incoming keg |
| Two transitions queued on one tap | FIFO by `opened_at`. The UI only offers to queue when none is pending, so this is a data-model generality, not a workflow |
| Ring arrives with no pending transition | Today's path, untouched — including correction-then-ring, which genuinely is a like-for-like restock of the corrected beer |
| Transition pending > 7 days | `stale_queued_swap` discrepancy; never auto-expired |
| Cold storage short on the incoming keg | Existing phantom-export path, unchanged |

## Testing

Pure logic, co-located per project rule:

- `lib/taproom/tapSwaps.test.ts` — FIFO pairing of transitions to restock events:
  one-to-one, two events one transition, one event two transitions, per-tap
  isolation, empty inputs.
- `lib/square/taproomConsumption.test.ts` (additions) — a paired unit takes
  `recipeId`/`variationId`/recount from the transition's `to_*`; an unpaired event
  still resolves off `tap_assignments`; `from_*`-null transitions produce no
  outgoing side.
- `lib/production/taproomConsumptionSync.test.ts` (additions) — claim is
  once-only under a repeated run; outgoing side skipped when the claim loses;
  multi-tap guard suppresses zeroing; shrinkage row carries the *outgoing*
  `recipe_id` and `full_fl_oz`; a Square failure in the outgoing side yields a
  discrepancy and does not block the incoming side.

## Out of scope

- **Amending swaps already booked wrong.** Historical `export_transactions` and
  `draft_swap_shrinkage` rows written under the old behavior are not corrected;
  no reversal path is added.
- **Distinguishing two taps of the same beer.** The per-recipe draft SKU cannot
  express separate levels; the multi-tap guard degrades safely instead.
- **Ring-first recovery.** A bartender ringing a beer change with no queued swap
  still books a like-for-like against current config.
- **Auto-expiring stale transitions.** Surfaced as a discrepancy only.

## Files touched

| File | Change |
| --- | --- |
| `supabase/migrations/20260816_tap_swap_transitions.sql` | new table, indexes, RLS |
| `lib/taproom/tapSwaps.ts` (+ test) | transition types + pure FIFO pairing |
| `lib/square/taproomConsumption.ts` | load pending transitions; pair; emit transition-bound units |
| `lib/production/taproomConsumptionSync.ts` | atomic claim, outgoing-side booking, tap flip, un-retire, new discrepancies |
| `lib/taproom/retireRecipe.ts` | extracted `is_retired` payload helper, shared with the existing settings route |
| `app/api/production/taproom-recipe-settings/route.ts` | use the extracted helper |
| `app/api/taproom/tap-swaps/route.ts` | POST queue, DELETE cancel |
| `app/api/taproom/draft-stats/route.ts` | per-tap `queued_swap` |
| `app/taproom/components/DraftStatsTab.tsx` | Swap keg action, confirm modal, queued badge |
