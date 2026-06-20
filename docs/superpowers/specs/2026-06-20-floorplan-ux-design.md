# Floorplan UX & Grid Fixes — Design

Date: 2026-06-20
Scope: `app/production/brewing/floorplan` (rendered by `BrewStatusTab.tsx`), `TransferModal.tsx`, `useTankDragDrop.ts`, `lib/constants/production.ts`, and a new equipment-grid migration.

## 1. Empty-tank bar + consistent "Next planned" placement

**Problem:** Occupied tanks show a fill-bar (`ledgerVol / capacity_bbl`). Empty tanks show nothing in that slot, so empty vs. occupied tiles don't read consistently. Separately, "Next planned" appears top-anchored on empty tiles but as a bottom-anchored block (just above Transfer) on occupied tiles — different tile states put it in different vertical positions, and the three render paths (grid tile, mobile card, occupied "next occupant") have independently-formatted markup.

**Fix:**
- Empty, constrained tanks (`isTank && !isUnconstrained && capacity_bbl`) render the same capacity/fill-bar row as occupied tanks, with the fill width at 0% — an "empty bar" rather than no bar. This is already structurally close: the capacity text line already renders for empty tanks; just always render the bar div underneath it (width 0%) instead of conditioning it on `batch`.
- Introduce a single shared component, `NextPlannedBox`, used by:
  - the occupied-tank "next occupant" block (`app/production/components/BrewStatusTab.tsx:949`)
  - the empty-tank block (`app/production/components/BrewStatusTab.tsx:1006`)
  - the mobile card empty-tank block (`app/production/components/BrewStatusTab.tsx:550`)

  Props: `batchNumber, beerName, plannedStart, volumeBbl`. Renders the same label/text/size markup in all three call sites.
- Layout rule: in both occupied and empty grid tiles, `NextPlannedBox` (or its absence) sits in a `shrink-0` slot **immediately above** the button row (Transfer/Assign), and the button row's container is always rendered (even when the button itself is conditionally hidden, e.g. `editMode`) so the box's position relative to the bottom of the tile doesn't shift. Concretely: keep the existing `flex-1 min-h-0` spacer pattern from the empty-tank branch, but move `NextPlannedBox` to sit right above the spacer's sibling button slot instead of at the top — i.e. structure becomes `[capacity row] → flex-1 spacer/scrollable content → [NextPlannedBox] → [button slot, always rendered with reserved height]`.
- Mobile cards: same `NextPlannedBox`, no special positioning constraints needed (cards don't need cross-tile alignment), but use the shared component for consistent formatting.

## 2. Transfer Batch modal spacing

**Problem:** The two-column grid (`grid-cols-1 md:grid-cols-2`) puts variable-height inline hints/warnings (deviation banner, capacity warning, "full conversion" notice) directly inside one column's flow, so the two columns drift out of vertical sync with each other row-by-row.

**Fix (in `TransferModal.tsx`):**
- Keep the 2-column grid for the *input* fields only (Destination select | Volume/Shrinkage inputs).
- Pull every conditional hint/warning/banner (deviation warning at `TransferModal.tsx:383`, capacity hint at `:390`, "full conversion" notice at `:429`) out of the per-column flow and render them as full-width rows directly below the entire 2-col grid, in source order. This guarantees column heights match (each column is just label+input+one fixed-height optional hint at most) and warnings get full-width room instead of being squeezed into a half-width column.
- The bottom summary section (`Volume summary` | `Notes`, `:566`) stays 2-column but add `items-start` (already implicit via block layout, but make explicit) and ensure the `Notes` `Field` doesn't stretch — wrap the summary box in `self-start`.
- No change to the keg/can detail grids — those are already internally consistent 2-column input forms; only the warnings around them move out.

## 3. "Up Next" → direct action wiring

**Problem:** Clicking an Up Next entry only opens a read-only "upcoming plans" popup. It doesn't show what tank the batch is *currently* in, nor let the user act on the transition directly.

**Fix:**
- Compute `currentTankByBatchId: Map<string, Equipment>` in `BrewStatusTab` — for each batch, find any tank where it currently has an active assignment (`assignments.find(a => a.batch_id === batchId)` → resolve `Equipment`). This is the "upstream action" the upcoming entry is sourced from.
- `TransferModal` gains optional props: `initialDestId?: string`, `initialMode?: "transfer" | "convert"`, `initialConvert?: { recipeId: string; beerName: string; bbl: string }`. When present, these override the existing default-selection logic on mount (existing `plannedDestId`/`plannedDestValid` logic already does something similar for the per-tank Transfer button — generalize it to also accept these explicit overrides from the Up Next banner).
- Up Next card click behavior, per entry `e` (resolving `currentTank = currentTankByBatchId.get(e.batch_id)`):
  1. **No `currentTank`** (batch not yet brewed/placed) → unchanged: open the existing read-only "Upcoming plans" popup (or, for `brewhouse` stage with unassigned batches, nothing changes — Assign already lives on the brewhouse tile itself).
  2. **`e.stage === "conditioning"` and `e.equipment_id === currentTank.id`** (in-place fermenting→conditioning) → button reads "Confirm Conditioning", opens `TransferModal` with `fromTank = currentTank`, `initialDestId = currentTank.id`, default full-volume mode.
  3. **`e.stage === "planned_conversion"`** → button reads "Convert", opens `TransferModal` with `fromTank = currentTank`, `initialMode = "convert"`, `initialConvert` populated from the entry's stored notes (`{ beer_name }`) and `volume_bbl`; recipe_id comes from the conversion entry if present, otherwise left blank for the user to pick.
  4. **Any other stage with a resolvable `e.equipment_id`** (fermenter→brite, brite→fermenter, →kegging, →canning) → button reads "Transfer", opens `TransferModal` with `fromTank = currentTank`, `initialDestId = e.equipment_id` (only applied if that tank is actually a valid destination per existing `DEST_RULES`/occupancy checks — otherwise falls back to the modal's normal first-valid-option default).
- The Up Next card itself keeps its current visual structure; the calendar-icon "Plans" popup remains reachable as a secondary affordance (small icon button), while the new direct-action button becomes the primary click target on the card.

## 4. Grid editing: drag-tracking bug + quarter-cell subdivision

**Bug:** `useTankDragDrop.onGridDragOver`/`onGridDrop` (`app/production/hooks/useTankDragDrop.ts:38-69`) compute grid cell from `(clientX - rect.left) / CELL`, where `CELL` is the fixed, unscaled `GRID_CELL_PX`. But the grid container is rendered inside a `transform: scale(gridScale)` wrapper (`BrewStatusTab.tsx:729`), so `rect` (from `getBoundingClientRect()`) reflects the *scaled* on-screen size while `CELL` does not. Whenever `gridScale !== 1` (the normal case on most screens), the computed row/col is wrong, causing the yellow/red preview to not track the cursor/equipment box correctly.

**Fix:** Pass `gridScale` into `useTankDragDrop(tanks, onRefresh, gridScale)` and divide by `CELL * gridScale` in both `onGridDragOver` and `onGridDrop` instead of `CELL`. `onDragStart`'s grab-offset calculation also divides by `CELL` against `e.currentTarget.getBoundingClientRect()` — that rect is the *tile's* DOM rect, which is also inside the scaled wrapper, so it needs the same `CELL * gridScale` correction for the grab offset to stay accurate while dragging.

**Quarter-cell subdivision:** Change `GRID_CELL_PX` 48→24 and `GRID_COLS`/`GRID_ROWS` 24→48 / 16→32 in `lib/constants/production.ts`. Add a new Supabase migration that multiplies every existing equipment row's `grid_row`, `grid_col`, `grid_width`, `grid_height` by 2 (preserves current visual layout exactly at the new finer resolution). No changes needed to collision (`wouldCollide`) or bounds (`isInBounds`) logic — both already operate in raw cell-unit integers and remain correct at the new resolution. The floorplan-settings min/max bounds (`min={8} max={40}` for cols, `min={4} max={32}` for rows in the grid-size inputs) should double in step with the new resolution (16/80 and 8/64) so admins can still size the grid in roughly the same physical range.

## 5. Vertical space: legend + Edit Layout row, and max zoom cap

**Legend/Edit Layout merge:** Combine the legend row (`BrewStatusTab.tsx:410-416`) and the Edit Layout / +Add Equipment row (`:381-407`) into a single flex row: legend badges on the left, Edit Layout / +Add Equipment buttons on the right (`ml-auto`), both using the same vertical padding/line-height so they align on one baseline. This removes one full row of vertical space above the grid. The "New Batch" mobile button stays in its own row (mobile-only, doesn't compete with this row since the merged row is `hidden md:flex`).

**Max zoom cap:** `gridScale` is currently `containerWidth / naturalGridWidth` with no upper bound (`BrewStatusTab.tsx:316-326`), so on wide viewports the grid can scale up past 1.0, making tile text larger than the fixed-px font sizes used in the Up Next banner — breaking visual consistency between the two. Clamp with `setGridScale(Math.min(1, width / naturalW))`, capping the grid at its native (1:1 with `GRID_CELL_PX`) resolution, which is sized to match the Up Next banner's font scale already.

## Out of scope
- No changes to the Square/Supabase data model beyond the single grid-coordinate migration in #4.
- No new API routes — all changes are presentational/UI plus one migration.
- #3 does not change what the backend considers a "deviation" or how transfers are recorded; it only pre-fills/opens existing flows faster.
