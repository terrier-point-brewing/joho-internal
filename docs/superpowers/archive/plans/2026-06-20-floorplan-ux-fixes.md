# Floorplan UX & Grid Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix five UX/usability issues on the Production → Brewing → Floorplan screen: empty-tank visual consistency, Transfer modal spacing, direct-action wiring from the "Up Next" banner, broken drag-and-drop placement tracking + finer grid resolution, and wasted vertical space in the legend/zoom behavior.

**Architecture:** All changes are in the existing `app/production` feature area — no new routes, no new tables beyond one coordinate-rescaling migration. Work proceeds bottom-up: grid resolution/constants first (everything else renders against `GRID_CELL_PX`), then the drag-math bug fix (depends on the scale value already computed in `BrewStatusTab`), then the three independent UI fixes (legend/zoom, tile layout, modal spacing), then the Up Next wiring last (it depends on `TransferModal` accepting new initial-state props).

**Tech Stack:** Next.js 16 App Router, TypeScript, Tailwind v4, Supabase Postgres (raw SQL migrations), React Query.

## Global Constraints

- This repo has **no test runner configured** (`package.json` only has `dev`/`build`/`start`/`lint`, no `test` script, no Jest/Vitest config). Per project convention, verification for each task is: `npm run lint`, `npm run build`, and a manual check via the dev server (start it, navigate to `/production/brewing/floorplan`, exercise the specific change). Do not introduce a new test framework as part of this plan — that would be a separate, explicit decision.
- Equipment grid units (`grid_row`, `grid_col`, `grid_width`, `grid_height`) are plain integers in `public.equipment` (`supabase/migrations/20260609_baseline.sql:57-68`). Migrations are additive-only — never hand-edit an existing migration file (per `CLAUDE.md`).
- Role gating for edit-mode UI: `canEditEquipment = role === "brewer" || role === "admin"` (`BrewStatusTab.tsx:74`); grid-size inputs are admin-only (`isAdmin`, `:700`). Do not loosen these checks.
- Keep all business logic out of `app/api/**` and page components — this plan only touches `app/production/**`, `lib/constants/production.ts`, and one migration, all already in the right layer.

---

### Task 1: Quarter-cell grid resolution (constants + migration)

**Files:**
- Modify: `lib/constants/production.ts`
- Modify: `app/production/components/BrewStatusTab.tsx:705-723` (grid-size input min/max bounds)
- Create: `supabase/migrations/20260620_double_equipment_grid_resolution.sql`

**Interfaces:**
- Consumes: nothing from other tasks (this is the foundational task).
- Produces: `GRID_CELL_PX = 24`, `GRID_COLS = 48`, `GRID_ROWS = 32` (all other tasks render against these constants; no function signatures change).

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260620_double_equipment_grid_resolution.sql`:

```sql
-- Double equipment grid coordinates/sizes to support quarter-cell placement
-- resolution. GRID_CELL_PX is halved client-side (48px -> 24px) and
-- GRID_COLS/GRID_ROWS are doubled (24x16 -> 48x32) in the same change, so
-- multiplying existing rows by 2 preserves every tank's current visual
-- position and size exactly.
update public.equipment
set
  grid_row    = grid_row * 2,
  grid_col    = grid_col * 2,
  grid_width  = grid_width * 2,
  grid_height = grid_height * 2;
```

- [ ] **Step 2: Apply the migration locally and verify**

Run: `npx supabase db push` (or your project's standard local-apply command — check `supabase/migrations/` for how the last few migrations were applied if unsure; this repo applies migrations directly to the linked Supabase project, there is no local Supabase stack running per `AGENTS.md`/`CLAUDE.md`).

Verify with a read query (e.g. via the Supabase SQL editor or `psql`):
```sql
select name, grid_row, grid_col, grid_width, grid_height from public.equipment order by name;
```
Expected: every previously-non-null `grid_row`/`grid_col` is double its old value, and every `grid_width`/`grid_height` is double its old value (e.g. a tank that was `grid_width = 2` is now `4`).

- [ ] **Step 3: Update grid constants**

Edit `lib/constants/production.ts`:

```ts
export const GALLONS_PER_BBL = 31;
export const BBL_TO_FL_OZ   = 3968; // 1 bbl = 31 gal = 3968 fl oz

// Brew Status grid — quarter-cell resolution: each visual square from the
// previous 48px/24-col/16-row grid is now 4 placement cells (2x2).
export const GRID_CELL_PX = 24;
export const GRID_GAP_PX  = 2;
export const GRID_COLS    = 48;
export const GRID_ROWS    = 32;
```

(`GRID_GAP_PX` drops from 3 to 2 — at half the cell size, a 3px gap would consume 12.5% of a 24px cell on each side; 2px keeps the visible gap proportionally similar to the old 3px-at-48px ratio.)

- [ ] **Step 4: Update grid-size input bounds to match the new resolution**

In `app/production/components/BrewStatusTab.tsx`, find the grid-size controls block (around line 700-723) and update the `min`/`max` on both number inputs:

```tsx
          <label className="flex items-center gap-1.5">
            Cols
            <input type="number" min={16} max={80} value={gridCols}
              onChange={(e) => {
                const v = Math.max(16, Math.min(80, parseInt(e.target.value) || GRID_COLS));
                setGridCols(v);
                saveGridSize(v, gridRows);
              }}
              className="w-16 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-200 text-xs" />
          </label>
          <label className="flex items-center gap-1.5">
            Rows
            <input type="number" min={8} max={64} value={gridRows}
              onChange={(e) => {
                const v = Math.max(8, Math.min(64, parseInt(e.target.value) || GRID_ROWS));
                setGridRows(v);
                saveGridSize(gridCols, v);
              }}
              className="w-16 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-200 text-xs" />
          </label>
```

(Old bounds were `min={8} max={40}` for cols and `min={4} max={32}` for rows — both doubled.)

- [ ] **Step 5: Verify build and visually check the grid**

Run: `npm run lint && npm run build`
Expected: no errors.

Start the dev server (`npm run dev`), open `/production/brewing/floorplan`. Expected: every tank renders at the same visual size and position as before this change (since stored coordinates were doubled in lockstep with the constants) — this is a resolution change, not a layout change. Existing custom grid sizes saved via `/api/production/floorplan-settings` will still be in old units; if the grid looks too small/cramped after this change, that's expected (the saved `cols`/`rows` need doubling too) — note this for manual follow-up but do not script a settings migration here, since `floorplan-settings` storage was out of scope for the schema migration in Step 1 (it's a small admin-configurable JSON, not equipment rows).

- [ ] **Step 6: Commit**

```bash
git add lib/constants/production.ts app/production/components/BrewStatusTab.tsx supabase/migrations/20260620_double_equipment_grid_resolution.sql
git commit -m "Double floorplan grid resolution to support quarter-cell placement"
```

---

### Task 2: Fix drag-tracking math (scale-aware drop preview)

**Files:**
- Modify: `app/production/hooks/useTankDragDrop.ts`
- Modify: `app/production/components/BrewStatusTab.tsx:304-326` (pass `gridScale` into the hook)

**Interfaces:**
- Consumes: `gridScale: number` state already computed in `BrewStatusTab` (`BrewStatusTab.tsx:315`, via `ResizeObserver` against `gridCols * cell`).
- Produces: `useTankDragDrop(tanks: Equipment[], onRefresh: () => Promise<void>, gridScale: number)` — same return shape as before (`dragging, dropPreview, gridRef, draggingTank, onDragStart, onGridDragOver, onGridDrop, onUnplacedDrop, removeFromGrid, clearDrag`), no signature changes to any of those returned functions.

**Root cause:** the grid is rendered inside a `transform: scale(gridScale)` wrapper (`BrewStatusTab.tsx:729`), so `getBoundingClientRect()` on the grid/tile returns the *visually scaled* size, while `useTankDragDrop` divides raw mouse coordinates by the unscaled `CELL` constant. Whenever `gridScale !== 1` (the normal case — the grid scales to fit the container width), the computed row/col is wrong, so the yellow/red drop preview doesn't track the actual cell under the cursor or the equipment box being dragged.

- [ ] **Step 1: Update `useTankDragDrop` to accept and use `gridScale`**

Replace the full contents of `app/production/hooks/useTankDragDrop.ts`:

```ts
"use client";

import React, { useState, useRef, useCallback } from "react";
import { Equipment } from "../types";
import { GRID_CELL_PX as CELL, GRID_ROWS, GRID_COLS } from "@/lib/constants/production";

function isInBounds(t: Equipment, row: number, col: number): boolean {
  return row >= 0 && col >= 0 && row + t.grid_height <= GRID_ROWS && col + t.grid_width <= GRID_COLS;
}

function wouldCollide(tanks: Equipment[], tankId: string, row: number, col: number): boolean {
  const drag = tanks.find((t) => t.id === tankId)!;
  return tanks
    .filter((t) => t.id !== tankId && t.grid_row != null && t.grid_col != null)
    .some((t) => {
      const tr = t.grid_row!, tc = t.grid_col!;
      return !(col + drag.grid_width <= tc || col >= tc + t.grid_width ||
               row + drag.grid_height <= tr || row >= tr + t.grid_height);
    });
}

export function useTankDragDrop(tanks: Equipment[], onRefresh: () => Promise<void>, gridScale: number) {
  const [dragging, setDragging] = useState<{ id: string; grabRow: number; grabCol: number } | null>(null);
  const [dropPreview, setDropPreview] = useState<{ row: number; col: number; valid: boolean } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // The grid (and every tile inside it) is rendered through a CSS
  // `transform: scale(gridScale)` wrapper, so `getBoundingClientRect()`
  // reflects the scaled on-screen size while CELL is a fixed, unscaled px
  // value. Every conversion from screen pixels to grid cells must divide by
  // the *effective* on-screen cell size (`CELL * gridScale`), not raw CELL,
  // or the computed row/col drifts from the cursor as soon as the grid is
  // scaled down to fit its container (the common case).
  const effectiveCell = CELL * (gridScale || 1);

  function onDragStart(e: React.DragEvent, t: Equipment) {
    const rect = e.currentTarget.getBoundingClientRect();
    const grabCol = Math.floor((e.clientX - rect.left) / effectiveCell);
    const grabRow = Math.floor((e.clientY - rect.top)  / effectiveCell);
    e.dataTransfer.setData("tankId",  t.id);
    e.dataTransfer.setData("grabCol", String(grabCol));
    e.dataTransfer.setData("grabRow", String(grabRow));
    e.dataTransfer.effectAllowed = "move";
    setDragging({ id: t.id, grabRow, grabCol });
  }

  const onGridDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!dragging || !gridRef.current) return;
    const rect = gridRef.current.getBoundingClientRect();
    const col = Math.max(0, Math.floor((e.clientX - rect.left + gridRef.current.scrollLeft) / effectiveCell) - dragging.grabCol);
    const row = Math.max(0, Math.floor((e.clientY - rect.top  + gridRef.current.scrollTop)  / effectiveCell) - dragging.grabRow);
    const tank = tanks.find((t) => t.id === dragging.id)!;
    const valid = isInBounds(tank, row, col) && !wouldCollide(tanks, dragging.id, row, col);
    setDropPreview({ row, col, valid });
  }, [dragging, tanks, effectiveCell]);

  async function onGridDrop(e: React.DragEvent) {
    e.preventDefault();
    if (!gridRef.current) return;
    const tankId  = e.dataTransfer.getData("tankId");
    const grabCol = parseInt(e.dataTransfer.getData("grabCol") || "0");
    const grabRow = parseInt(e.dataTransfer.getData("grabRow") || "0");
    const rect = gridRef.current.getBoundingClientRect();
    const col  = Math.max(0, Math.floor((e.clientX - rect.left + gridRef.current.scrollLeft) / effectiveCell) - grabCol);
    const row  = Math.max(0, Math.floor((e.clientY - rect.top  + gridRef.current.scrollTop)  / effectiveCell) - grabRow);
    const tank = tanks.find((t) => t.id === tankId);
    if (tank && isInBounds(tank, row, col) && !wouldCollide(tanks, tankId, row, col)) {
      await fetch(`/api/production/equipment/${tankId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grid_row: row, grid_col: col }),
      });
      await onRefresh();
    }
    setDragging(null);
    setDropPreview(null);
  }

  async function removeFromGrid(tankId: string) {
    await fetch(`/api/production/equipment/${tankId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grid_row: null, grid_col: null }),
    });
    await onRefresh();
  }

  async function onUnplacedDrop(e: React.DragEvent) {
    e.preventDefault();
    const tankId = e.dataTransfer.getData("tankId");
    if (tankId) await removeFromGrid(tankId);
    setDragging(null);
    setDropPreview(null);
  }

  const draggingTank = dragging ? tanks.find((t) => t.id === dragging.id) ?? null : null;

  return {
    dragging, dropPreview, gridRef, draggingTank,
    onDragStart, onGridDragOver, onGridDrop, onUnplacedDrop, removeFromGrid,
    clearDrag: () => { setDragging(null); setDropPreview(null); },
  };
}
```

- [ ] **Step 2: Pass `gridScale` from `BrewStatusTab`**

In `app/production/components/BrewStatusTab.tsx`, the hook is currently invoked before `gridScale` is computed (hook call is around line 304-307, `gridScale` state/effect is around line 314-326). Reorder so `gridScale` exists first, then pass it in.

Move the `scaleContainerRef`/`gridScale` block (currently lines 313-326) to sit *above* the `useTankDragDrop` call (currently lines 301-308), then update the call:

```tsx
  // Scale the grid to fit the available container dimensions.
  const scaleContainerRef = useRef<HTMLDivElement>(null);
  const [gridScale, setGridScale] = useState(1);
  useEffect(() => {
    const el = scaleContainerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => {
      const { width } = entry.contentRect;
      const naturalW = gridCols * cell;
      setGridScale(width / naturalW);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [gridCols, gridRows, cell]);

  // Destructure so the ref (gridRef) and state (dragging/dropPreview/…) keep
  // distinct identities — otherwise the React Compiler taints every access on
  // the returned object as "accessing refs during render".
  const {
    dragging, dropPreview, gridRef, draggingTank,
    onDragStart, onGridDragOver, onGridDrop, onUnplacedDrop, removeFromGrid, clearDrag,
  } = useTankDragDrop(tanks, onRefresh, gridScale);
  const eqCrud = useEquipmentCrud(onRefresh);
  const assign = useBatchAssign(unassignedBatches, onRefresh);

  const cell = CELL;
```

Note: `cell` (= `CELL`) is referenced inside the `ResizeObserver` callback above before its `const cell = CELL;` declaration if left in the original order — since `cell` is a `const` from the outer module-level import alias, JS would still throw on use-before-declaration only for genuine block-scoped `let`/`const` access before the statement runs at *runtime*, not at parse time. To avoid any ambiguity, move `const cell = CELL;` to **before** the `scaleContainerRef`/`gridScale` block (i.e., right after the existing tank/assignment query destructuring), so the read order is: `cell` defined → `gridScale` effect (uses `cell`) → `useTankDragDrop(tanks, onRefresh, gridScale)`.

- [ ] **Step 3: Verify build**

Run: `npm run lint && npm run build`
Expected: no errors, no "used before defined" issues.

- [ ] **Step 4: Manual verification of the fix**

Start `npm run dev`, open `/production/brewing/floorplan` as a brewer/admin role, click "Edit Layout". Resize the browser window narrower (forcing `gridScale < 1`) and drag a tank around. Expected: the dashed yellow/red preview box stays directly under the dragged tile (following the cursor 1:1), instead of lagging/drifting as it did before. Confirm a drop lands the tank at the cell visually under the cursor.

- [ ] **Step 5: Commit**

```bash
git add app/production/hooks/useTankDragDrop.ts app/production/components/BrewStatusTab.tsx
git commit -m "Fix drag-and-drop placement preview to account for grid zoom scale"
```

---

### Task 3: Merge legend into Edit Layout row + cap max zoom

**Files:**
- Modify: `app/production/components/BrewStatusTab.tsx:380-416` (header/legend rows)
- Modify: `app/production/components/BrewStatusTab.tsx` (the `gridScale` `ResizeObserver` callback from Task 2, Step 2)

**Interfaces:**
- Consumes: `gridScale` state/setter from Task 2 (already in scope in this file).
- Produces: no new exports; purely JSX/layout restructuring within `BrewStatusTab`.

- [ ] **Step 1: Cap grid zoom at native resolution**

In the `ResizeObserver` callback set up in Task 2 (Step 2), change:

```tsx
    const obs = new ResizeObserver(([entry]) => {
      const { width } = entry.contentRect;
      const naturalW = gridCols * cell;
      setGridScale(width / naturalW);
    });
```

to:

```tsx
    const obs = new ResizeObserver(([entry]) => {
      const { width } = entry.contentRect;
      const naturalW = gridCols * cell;
      setGridScale(Math.min(1, width / naturalW));
    });
```

This caps the grid at 1:1 with `GRID_CELL_PX` so tile text never renders larger than its fixed `px` font sizes — keeping it visually consistent with the Up Next banner's fixed-size text regardless of viewport width.

- [ ] **Step 2: Merge the legend row into the Edit Layout row**

Replace the two separate blocks (header/Edit Layout row at `BrewStatusTab.tsx:380-407` and the legend row at `:409-416`) with a single merged row:

```tsx
      {/* Header — mobile new batch, legend, and edit layout controls (desktop) on one row */}
      <div className="flex items-center justify-between gap-2 mb-4">
        {/* Mobile: New Batch shortcut */}
        <button
          onClick={() => { setBatchForm(BATCH_EMPTY); setShowNewBatch(true); }}
          className="md:hidden btn-amber text-xs"
        >
          + New Batch
        </button>

        {/* Desktop: legend (left) + Edit Layout controls (right), same row */}
        <div className="hidden md:flex items-center justify-between w-full gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {EQ_TYPES.map(([type, meta]) => (
              <span key={type} className={`text-xs px-2 py-px rounded border ${meta.badge}`}>
                {meta.label}
              </span>
            ))}
          </div>
          {canEditEquipment && (
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => setEditMode((v) => !v)}
                className={`px-3 py-1.5 text-sm font-medium rounded border transition-colors ${
                  editMode
                    ? "border-amber-600 bg-amber-900/30 text-amber-300 hover:bg-amber-900/50"
                    : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {editMode ? "🔓 Editing Layout" : "🔒 Edit Layout"}
              </button>
              {editMode && (
                <button onClick={eqCrud.openNew} className="btn-amber">+ Add Equipment</button>
              )}
            </div>
          )}
        </div>
      </div>
```

This removes the standalone legend `<div className="hidden md:flex flex-wrap gap-2 mb-3">...</div>` entirely (its content is now inside the merged row) — delete that whole block from the file.

- [ ] **Step 3: Verify build and visually check**

Run: `npm run lint && npm run build`
Expected: no errors.

Start `npm run dev`, open `/production/brewing/floorplan` as brewer/admin on desktop width. Expected: one row contains the legend badges on the left and Edit Layout/+Add Equipment on the right, at the same vertical position — saving the ~32px the old standalone legend row used to take. Resize the browser wider than the natural grid width (`GRID_COLS * GRID_CELL_PX` = 48 × 24 = 1152px) and confirm the grid no longer scales up past 100% (tile text stays the same size it was at 100%).

- [ ] **Step 4: Commit**

```bash
git add app/production/components/BrewStatusTab.tsx
git commit -m "Merge floorplan legend into Edit Layout row and cap grid zoom at 100%"
```

---

### Task 4: Shared `NextPlannedBox` + empty-tank fill bar + consistent bottom-pinned layout

**Files:**
- Create: `app/production/components/FloorplanTile/NextPlannedBox.tsx`
- Modify: `app/production/components/BrewStatusTab.tsx` (three call sites: mobile card empty-tank block, grid-tile occupied "next occupant" block, grid-tile empty-tank block)

**Interfaces:**
- Produces: `NextPlannedBox({ batchNumber, beerName, plannedStart, volumeBbl, size }: { batchNumber: string | null; beerName: string; plannedStart: string; volumeBbl: number | null; size?: "sm" | "xs" }) => JSX.Element` — `size` controls font sizes (`"sm"` for the mobile card, default `"xs"` for the dense grid tiles, matching today's two distinct font-size sets).
- Consumes: `fmtDate` from `@/lib/utils/formatting` (already imported in `BrewStatusTab.tsx:10`).

- [ ] **Step 1: Create the shared component**

Create `app/production/components/FloorplanTile/NextPlannedBox.tsx`:

```tsx
"use client";

import { fmtDate } from "@/lib/utils/formatting";

interface NextPlannedBoxProps {
  batchNumber: string | null;
  beerName: string;
  plannedStart: string;
  volumeBbl: number | null;
  /** "sm" = mobile card text size, "xs" (default) = dense grid-tile text size */
  size?: "sm" | "xs";
}

/**
 * Renders the "Next planned" callout shown on a tank tile when a future,
 * not-yet-started schedule entry exists for it — used identically across
 * the grid tile (occupied-but-has-a-next-occupant case), the grid tile
 * (fully empty case), and the mobile card empty-tank case, so all three
 * read with the same label/format/sizing.
 */
export default function NextPlannedBox({ batchNumber, beerName, plannedStart, volumeBbl, size = "xs" }: NextPlannedBoxProps) {
  const labelSize = size === "sm" ? 11 : 7;
  const titleSize = size === "sm" ? 13 : 8;
  const metaSize  = size === "sm" ? 12 : 7;
  return (
    <div className="px-1 py-0.5 rounded bg-zinc-800/60 border border-zinc-700/50 w-full min-w-0">
      <p className="text-zinc-500 font-semibold uppercase tracking-wide" style={{ fontSize: labelSize }}>Next planned</p>
      <p className="text-zinc-300 font-medium truncate" style={{ fontSize: titleSize }} title={`#${batchNumber ?? "?"} ${beerName}`}>
        #{batchNumber ?? "?"} {beerName}
      </p>
      <p className="text-zinc-600 truncate" style={{ fontSize: metaSize }}>
        {fmtDate(plannedStart)}{volumeBbl != null && ` · ${volumeBbl} BBL`}
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Use it in the empty-tank grid tile branch, bottom-pinned above the button slot**

In `app/production/components/BrewStatusTab.tsx`, the empty-tank tile branch is the `else` of `batch ? (...) : (...)` inside the `isTank` block (around lines 1000-1036). Replace that entire `else` branch:

```tsx
                        ) : (
                          <div className="flex-1 min-h-0 flex flex-col gap-0.5">
                            {/* Capacity bar reserved for empty tanks too (0% fill), so empty
                                and occupied tiles read consistently — see capacity row above,
                                which already always renders the text line; this adds the bar. */}
                            {!isUnconstrained && tank.capacity_bbl && (
                              <div className="shrink-0 w-full rounded-full overflow-hidden" style={{ height: 3, background: "rgba(63,63,70,0.6)", marginBottom: 2 }} />
                            )}
                            {/* Spacer — pushes Next planned + button slot to the bottom,
                                same position they occupy on an occupied tile. */}
                            <div className="flex-1 min-h-0" />
                            {nextPlanned?.brew_batches && (
                              <div className="shrink-0">
                                <NextPlannedBox
                                  batchNumber={nextPlanned.brew_batches.batch_number}
                                  beerName={nextPlanned.brew_batches.beer_name}
                                  plannedStart={nextPlanned.planned_start}
                                  volumeBbl={nextPlanned.brew_batches.volume_bbl}
                                />
                              </div>
                            )}
                            {!nextPlanned?.brew_batches && (
                              <p className="shrink-0 text-zinc-700" style={{ fontSize: 9 }}>Empty</p>
                            )}
                            {/* Button slot — always reserved, even when no button renders,
                                so Next planned sits at the same height as the Transfer slot
                                on an occupied tile. */}
                            <div className="shrink-0" style={{ minHeight: !editMode && tank.type === "brewhouse" && unassignedBatches.length > 0 ? undefined : 18 }}>
                              {!editMode && tank.type === "brewhouse" && unassignedBatches.length > 0 && (
                                <button
                                  onClick={() => assign.openAssign(tank.id)}
                                  onMouseDown={(e) => e.stopPropagation()}
                                  className="w-full text-amber-600 hover:text-amber-400 border border-amber-900 hover:border-amber-700 px-1.5 rounded transition-colors"
                                  style={{ fontSize: 9 }}
                                >
                                  Assign
                                </button>
                              )}
                            </div>
                          </div>
                        )}
```

(`minHeight: 18` on the reserved button slot matches the rendered height of the `Assign`/`Transfer` buttons elsewhere in this file — they use `px-1.5` with `fontSize: 9` text and no explicit height, which measures ~18px with the existing padding; this keeps the slot's height stable whether or not the button renders.)

Add the import at the top of `BrewStatusTab.tsx` (alongside the existing `TransferModal` import):

```tsx
import NextPlannedBox from "./FloorplanTile/NextPlannedBox";
```

- [ ] **Step 3: Use it in the occupied-tank "next occupant" block**

In the same file, the occupied-tank `nextOccupant` block (around lines 949-957) currently inlines the same markup. Replace:

```tsx
                                {nextOccupant && (
                                  <div className="pt-0.5 border-t border-zinc-800/60 px-1 py-0.5 rounded bg-zinc-800/40 min-w-0">
                                    <p className="text-zinc-500 font-semibold uppercase tracking-wide" style={{ fontSize: 7 }}>Next planned</p>
                                    <p className="text-zinc-400 truncate" style={{ fontSize: 8 }} title={`#${nextOccupant.brew_batches!.batch_number} ${nextOccupant.brew_batches!.beer_name}`}>
                                      #{nextOccupant.brew_batches!.batch_number} {nextOccupant.brew_batches!.beer_name}
                                      <span className="text-zinc-600"> · {fmtDate(nextOccupant.planned_start)}</span>
                                    </p>
                                  </div>
                                )}
```

with:

```tsx
                                {nextOccupant && (
                                  <div className="pt-0.5 border-t border-zinc-800/60">
                                    <NextPlannedBox
                                      batchNumber={nextOccupant.brew_batches!.batch_number}
                                      beerName={nextOccupant.brew_batches!.beer_name}
                                      plannedStart={nextOccupant.planned_start}
                                      volumeBbl={null}
                                    />
                                  </div>
                                )}
```

(`volumeBbl={null}` here because the original occupied-tile rendering didn't show volume for the next occupant, only date — keep that exact behavior; the empty-tile call site in Step 2 does pass volume, matching its own prior behavior. This is an intentional, pre-existing difference in what each call site shows, not a regression: the component's `size`/visible-fields contract allows omitting volume via `null`.)

- [ ] **Step 4: Use it in the mobile card empty-tank block**

Around line 546-572 (the mobile-card `isTank` empty branch), replace:

```tsx
                                {nextPlanned && nextPlanned.brew_batches ? (
                                  <>
                                    <p className="text-xs text-zinc-500 font-semibold uppercase tracking-wide mb-0.5">Next planned</p>
                                    <p className="text-sm text-zinc-300 font-medium truncate">
                                      #{nextPlanned.brew_batches.batch_number} {nextPlanned.brew_batches.beer_name}
                                    </p>
                                    <p className="text-xs text-zinc-600">{nextPlanned.planned_start.slice(0, 10)} · {nextPlanned.brew_batches.volume_bbl} BBL</p>
                                  </>
                                ) : (
                                  <p className="text-sm text-zinc-600">Empty</p>
                                )}
```

with:

```tsx
                                {nextPlanned && nextPlanned.brew_batches ? (
                                  <NextPlannedBox
                                    batchNumber={nextPlanned.brew_batches.batch_number}
                                    beerName={nextPlanned.brew_batches.beer_name}
                                    plannedStart={nextPlanned.planned_start}
                                    volumeBbl={nextPlanned.brew_batches.volume_bbl}
                                    size="sm"
                                  />
                                ) : (
                                  <p className="text-sm text-zinc-600">Empty</p>
                                )}
```

- [ ] **Step 5: Verify build and visually check**

Run: `npm run lint && npm run build`
Expected: no errors.

Start `npm run dev`, open `/production/brewing/floorplan`. Expected:
- An empty fermenter/brite/brewhouse tile shows a (0%-filled) capacity bar identical in position/style to an occupied tile's fill bar.
- "Next planned" appears at the same vertical position (just above where Transfer/Assign would be) on both empty tiles and occupied tiles that have an upcoming next-occupant.
- Tiles without any "Next planned" data still reserve the same bottom slot height (no layout jump when toggling between tanks that have/don't have a next-planned entry).
- Mobile width (resize below `md` breakpoint, or use device toolbar) shows the same data via `NextPlannedBox` in the card view.

- [ ] **Step 6: Commit**

```bash
git add app/production/components/FloorplanTile/NextPlannedBox.tsx app/production/components/BrewStatusTab.tsx
git commit -m "Add shared NextPlannedBox and empty-tank fill bar for consistent tile layout"
```

---

### Task 5: Transfer Batch modal spacing fixes

**Files:**
- Modify: `app/production/components/TransferModal.tsx`

**Interfaces:**
- Consumes: nothing new — no prop/type changes in this task (those come in Task 6).
- Produces: no new exports; purely JSX restructuring.

- [ ] **Step 1: Pull the deviation warning and capacity hint out of the Destination column**

In `TransferModal.tsx`, the `Field label="Destination"` block (around lines 357-393) currently nests the deviation warning (`:383-389`) and capacity hint (`:390-392`) inside the same column as the destination `<select>`. Replace the whole `<Field label="Destination" ...>...</Field>` element plus the two-column grid wrapper it's inside, restructuring so warnings render full-width below the grid:

Find this structure (lines 337-472, the `grid grid-cols-1 md:grid-cols-2 gap-4` block containing the "where it's going" and "how much" columns):

```tsx
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* ── Left column: where it's going ── */}
          <div className="space-y-3">
            ...
            <Field label={mode === "convert" ? "Destination" : "Destination"} required>
              {/* Planned booking pill (transfer mode only) */}
              {mode === "transfer" && plannedEntry && plannedEntry.equipment_id && (
                ...
              )}
              <select className="inp" value={effectiveDestId} required onChange={(e) => setDestId(e.target.value)}>
                ...
              </select>
              {destTanks.length === 0 && mode === "convert" && (
                <p className="text-xs text-zinc-500 mt-1">No free tanks available for a conversion from this stage.</p>
              )}
              {/* Deviation warning (transfer mode only) */}
              {mode === "transfer" && plannedEntry && plannedEntry.equipment_id && effectiveDestId && effectiveDestId !== plannedEntry.equipment_id && (
                <div className="mt-1.5 px-3 py-2 rounded border border-amber-700/60 bg-amber-950/40 text-xs text-amber-300">
                  ⚠ <span className="font-semibold">Deviation from plan:</span> this batch was scheduled for{" "}
                  <span className="text-amber-200 font-medium">{plannedEntry.equipment?.name ?? "another tank"}</span>.
                  Proceeding will cancel that booking and may cause conflicts with downstream schedule entries that will need to be resolved.
                </div>
              )}
              {mode === "transfer" && destIsConstrained && destTank?.capacity_bbl && (
                <p className="text-xs text-zinc-500 mt-0.5">Capacity: {fmtBbl(destTank.capacity_bbl)} — transfer will be rejected if it exceeds this.</p>
              )}
            </Field>
          </div>

          {/* ── Right column: how much / what's converting ── */}
          <div className="space-y-3">
            ... (convert fields / volume fields / shrinkage field, unchanged)
          </div>
        </div>
```

Replace it with (warnings/hints moved to a full-width block immediately after the grid, inputs-only inside the grid):

```tsx
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
          {/* ── Left column: where it's going (inputs only) ── */}
          <div className="space-y-3">
            {/* Convert mode description */}
            {mode === "convert" && (
              <div className="px-3 py-2 rounded border border-amber-700/40 bg-amber-950/30 text-xs text-amber-300">
                Split a partial volume into a <span className="font-semibold">new batch</span> under a different recipe. The remaining volume stays in {fromTank.name} under the original batch.
              </div>
            )}

            {/* Allowed-destinations hint (transfer mode only) */}
            {mode === "transfer" && (
              <p className="text-xs text-zinc-500 bg-zinc-800/40 px-3 py-1.5 rounded border border-zinc-700">
                {fromTank.type === "brewhouse" && "Brewhouse → Fermenter only"}
                {fromTank.type === "fermenter" && "Fermenter → Brite/Fermenter (incl. staying put for in-place conditioning), Kegging, or Canning"}
                {fromTank.type === "brite"     && "Brite → Brite/Fermenter (incl. staying put), Kegging, or Canning"}
                {(fromTank.type === "kegging" || fromTank.type === "canning") && "Packaging → Cold Storage or Export Bay only"}
              </p>
            )}

            <Field label="Destination" required>
              {/* Planned booking pill (transfer mode only) */}
              {mode === "transfer" && plannedEntry && plannedEntry.equipment_id && (
                <div className="flex items-center gap-2 mb-2 px-2 py-1.5 rounded bg-zinc-800/60 border border-zinc-700 text-xs text-zinc-400">
                  <span>📋 Planned:</span>
                  <span className="text-zinc-200 font-medium">{plannedEntry.equipment?.name ?? "Unknown"}</span>
                  <span className="text-zinc-500">
                    {format(parseISO(plannedEntry.planned_start), "MMM d")}–{format(parseISO(plannedEntry.planned_end), "MMM d")}
                  </span>
                </div>
              )}
              <select className="inp" value={effectiveDestId} required onChange={(e) => setDestId(e.target.value)}>
                <option value="">— select —</option>
                {destTanks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({EQ[t.type]?.label ?? t.type})
                    {t.id === fromTank.id ? " · stay in place" : ""}
                    {t.capacity_bbl ? ` · ${t.capacity_bbl} BBL` : ""}
                    {(occupiedTankRecipeIds?.[t.id]?.length ?? 0) > 0 ? " · combining with existing batch" : ""}
                  </option>
                ))}
              </select>
              {destTanks.length === 0 && mode === "convert" && (
                <p className="text-xs text-zinc-500 mt-1">No free tanks available for a conversion from this stage.</p>
              )}
            </Field>
          </div>

          {/* ── Right column: how much / what's converting ── */}
          <div className="space-y-3">
            {/* ── Convert mode fields ── */}
            {mode === "convert" && (
              <>
                <Field label="New Recipe" required>
                  <select className="inp" value={convertRecipeId} required onChange={(e) => {
                    const r = recipes.find((r) => r.id === e.target.value);
                    setConvertRecipeId(e.target.value);
                    if (r && !convertBeerName) setConvertBeerName(r.beer_name);
                  }}>
                    <option value="">— select recipe —</option>
                    {recipes.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.beer_name}{r.brewery ? ` · ${r.brewery}` : ""}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="New Batch Name" required>
                  <input className="inp" value={convertBeerName} required
                    placeholder="e.g. Wheat Wit"
                    onChange={(e) => setConvertBeerName(e.target.value)} />
                </Field>

                <Field label="Volume to Convert (BBL)" required>
                  <div className="flex items-center gap-2">
                    <input type="number" step="0.001" min="0.001" max={batchVol} className="inp w-40"
                      placeholder="0.000" required
                      value={convertBbl} onChange={(e) => setConvertBbl(e.target.value)} />
                    <span className="text-zinc-500 text-sm">BBL</span>
                  </div>
                </Field>
              </>
            )}

            {/* ── Regular transfer: full / partial ── */}
            {mode === "transfer" && !isPackagingForm && (
              <Field label="Volume">
                <div className="flex gap-2 mb-2">
                  <button type="button" onClick={() => setVolumeMode("full")}
                    className={`px-3 py-1.5 text-sm rounded border transition-colors ${volumeMode === "full" ? "border-amber-600 bg-amber-900/30 text-amber-300" : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}>
                    Full transfer
                  </button>
                  <button type="button" onClick={() => setVolumeMode("partial")}
                    className={`px-3 py-1.5 text-sm rounded border transition-colors ${volumeMode === "partial" ? "border-amber-600 bg-amber-900/30 text-amber-300" : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}>
                    Partial
                  </button>
                </div>
                {volumeMode === "partial" && (
                  <div className="flex items-center gap-2">
                    <input type="number" step="0.001" min="0" max={batchVol} className="inp w-40" placeholder="0.000"
                      value={partialBbl} onChange={(e) => setPartialBbl(e.target.value)} />
                    <span className="text-zinc-500 text-sm">BBL</span>
                  </div>
                )}
              </Field>
            )}

            {/* Shrinkage — not applicable for packaging out-transfers or conversions */}
            {mode === "transfer" && !isPackagingForm && (
              <Field label="Shrinkage (BBL)">
                <div className="flex items-center gap-2">
                  <input type="number" step="0.001" min="0" className="inp w-40" placeholder="0.000"
                    value={shrinkage} onChange={(e) => setShrinkage(e.target.value)} />
                  <span className="text-zinc-500 text-sm">BBL lost</span>
                </div>
              </Field>
            )}
          </div>
        </div>

        {/* ── Full-width hints/warnings, kept out of the 2-col grid above so
             column heights stay in sync regardless of which warnings show ── */}
        {mode === "transfer" && destIsConstrained && destTank?.capacity_bbl && (
          <p className="text-xs text-zinc-500">Capacity: {fmtBbl(destTank.capacity_bbl)} — transfer will be rejected if it exceeds this.</p>
        )}
        {mode === "transfer" && plannedEntry && plannedEntry.equipment_id && effectiveDestId && effectiveDestId !== plannedEntry.equipment_id && (
          <div className="px-3 py-2 rounded border border-amber-700/60 bg-amber-950/40 text-xs text-amber-300">
            ⚠ <span className="font-semibold">Deviation from plan:</span> this batch was scheduled for{" "}
            <span className="text-amber-200 font-medium">{plannedEntry.equipment?.name ?? "another tank"}</span>.
            Proceeding will cancel that booking and may cause conflicts with downstream schedule entries that will need to be resolved.
          </div>
        )}
        {mode === "convert" && drawBbl > 0 && remaining <= 0 && (
          <p className="text-amber-400 text-xs">
            Full conversion — the parent batch will be archived after this.
          </p>
        )}
```

(The "full conversion" notice, originally nested inside the convert-mode `Volume to Convert` `Field` at lines 429-433, is also moved to this full-width block for the same reason — it was making the right column taller than the left column whenever it showed.)

- [ ] **Step 2: Keep the bottom summary/notes row symmetric**

The bottom `grid-cols-1 md:grid-cols-2 gap-4` block (Volume summary | Notes, around line 566-597) doesn't have the same variable-height-hint problem (its only conditional content, the red exceeds-capacity warning, is already inside the summary box itself and doesn't compare against the Notes column). Add `items-start` to this grid for safety/consistency with the grid above:

```tsx
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
```

- [ ] **Step 3: Verify build and visually check**

Run: `npm run lint && npm run build`
Expected: no errors.

Start `npm run dev`, open the floorplan, click "Transfer" on an occupied fermenter that has a planned next-stage entry pointing elsewhere (to trigger the deviation warning) — or any fermenter/brite tank to at least see the standard layout. Expected: the Destination column and the Volume/Shrinkage column end at the same height; switching the destination dropdown to trigger the deviation warning doesn't visually unbalance the two columns (the warning now renders full-width below both).

- [ ] **Step 4: Commit**

```bash
git add app/production/components/TransferModal.tsx
git commit -m "Fix Transfer Batch modal column misalignment by moving warnings out of the input grid"
```

---

### Task 6: "Up Next" direct-action wiring

**Files:**
- Modify: `app/production/components/TransferModal.tsx` (add optional initial-state props)
- Modify: `app/production/components/BrewStatusTab.tsx` (compute current-tank map, restructure Up Next card click handling, pass new props to `TransferModal`)

**Interfaces:**
- Consumes: `NextPlannedBox` is not used here (separate component); uses existing `ScheduleEntry`, `Equipment`, `BatchTankAssignment` types, and `TransferModal`'s existing `DEST_RULES`/`destTanks` computation.
- Produces: `TransferModal` gains three new optional props:
  ```ts
  initialDestId?: string;
  initialMode?: "transfer" | "convert";
  initialConvert?: { recipeId: string; beerName: string; bbl: string };
  ```
  No existing prop or exported type changes name or shape.

**Background (from research, not in the original spec doc — confirmed while implementing):** schedule entries with `stage === "planned_conversion"` are currently excluded from `upcomingTasks` entirely (`BrewStatusTab.tsx:276`, `e.stage !== "planned_conversion"`). Their `equipment_id` is always the *source* tank (the conversion marker is recorded against the batch being drawn from, not the new batch's destination — see `ConvertPanel.tsx:122-137`), and their `notes` field is `JSON.stringify({ beer_name, child_batch_id })`. To wire a "Convert" action for these, the filter must be removed and the special-case handling must treat `e.equipment_id` as the *current* (source) tank, not a destination.

- [ ] **Step 1: Add initial-state props to `TransferModal`**

In `app/production/components/TransferModal.tsx`, update the props interface and the four `useState` initializations that the new props should seed.

Change the interface (around lines 41-57):

```tsx
interface TransferModalProps {
  batch: BrewBatch;
  fromTank: Equipment;
  allTanks: Equipment[];
  /** IDs of tanks that currently have an active batch assignment */
  occupiedTankIds: Set<string>;
  /** recipe_id(s) of whichever batch(es) currently occupy each tank, keyed by tank id */
  occupiedTankRecipeIds?: Record<string, (string | null)[]>;
  packaging: PackagingItem[];
  recipes: Recipe[];
  /** Ledger volume currently in fromTank; falls back to batch.volume_bbl if omitted */
  fromTankVolume?: number;
  /** Next planned schedule entry for the next stage of this batch (from batch_schedule_entries) */
  plannedEntry?: ScheduleEntry | null;
  /** Pre-select this destination tank on open, overriding the planned-entry auto-select, if it's a valid destination */
  initialDestId?: string;
  /** Open directly into Convert mode instead of the default Transfer mode */
  initialMode?: "transfer" | "convert";
  /** Pre-fill the Convert-mode fields (used when opened from a planned conversion's "Convert" action) */
  initialConvert?: { recipeId: string; beerName: string; bbl: string };
  onClose: () => void;
  onDone: (response?: { schedule_update?: { action: string; was_deviation?: boolean; equipment_name?: string }[] }) => Promise<void>;
}
```

Change the function signature (around line 64):

```tsx
export default function TransferModal({ batch, fromTank, allTanks, occupiedTankIds, occupiedTankRecipeIds, packaging, recipes, fromTankVolume, plannedEntry, initialDestId, initialMode, initialConvert, onClose, onDone }: TransferModalProps) {
  const [mode, setMode] = useState<"transfer" | "convert">(initialMode ?? "transfer");
```

Update the `destId` initial state (around line 110) — `initialDestId` takes priority over the planned-entry auto-select, but only if it's actually a valid destination:

```tsx
  // Pre-select planned destination if the planned entry points to a valid available tank;
  // an explicit initialDestId (from the Up Next banner) takes priority over both.
  const plannedDestId = plannedEntry?.equipment_id ?? null;
  const plannedDestValid = plannedDestId ? destTanks.some((t) => t.id === plannedDestId) : false;
  const initialDestValid = initialDestId ? destTanks.some((t) => t.id === initialDestId) : false;
  const [destId, setDestId] = useState(
    initialDestValid && initialDestId ? initialDestId
      : plannedDestValid && plannedDestId ? plannedDestId
      : (destTanks[0]?.id ?? "")
  );
```

Update the convert-mode field initial states (around lines 126-128):

```tsx
  // Conversion-specific state
  const [convertRecipeId, setConvertRecipeId] = useState(initialConvert?.recipeId ?? "");
  const [convertBeerName, setConvertBeerName] = useState(initialConvert?.beerName ?? "");
  const [convertBbl,      setConvertBbl]      = useState(initialConvert?.bbl ?? "");
```

- [ ] **Step 2: Verify `TransferModal` still builds in isolation**

Run: `npm run lint`
Expected: no errors (no callers updated yet, so all new props are optional and unused so far — this should be a no-op change for existing callers).

- [ ] **Step 3: Stop excluding `planned_conversion` entries from Up Next, and resolve each entry's current tank**

In `app/production/components/BrewStatusTab.tsx`:

a) Remove the `planned_conversion` exclusion from `upcomingTasks` (around line 274-278):

```tsx
  // Flattened, globally-sorted upcoming tasks for the top banner.
  const upcomingTasks = React.useMemo(() => {
    return [...scheduleEntries]
      .filter(e => e.equipment_id && !e.cancelled_at && !e.actual_start)
      .sort((a, b) => a.planned_start.localeCompare(b.planned_start));
  }, [scheduleEntries]);
```

b) Add a `currentTankByBatchId` map right after the existing `assignmentByTank`/`assignmentsByTank` computation (around line 223-227):

```tsx
  const assignmentByTank   = Object.fromEntries(assignments.map((a) => [a.tank_id, a])) as Record<string, BatchTankAssignment | undefined>;
  // Same-recipe batches can combine in one tank, so a tank may have more than
  // one active assignment — group them so tiles can show every occupant.
  const assignmentsByTank: Record<string, BatchTankAssignment[]> = {};
  for (const a of assignments) (assignmentsByTank[a.tank_id] ??= []).push(a);
  // Reverse lookup: which tank (if any) currently holds a given batch — this
  // is the "current upstream action" an Up Next entry is sourced from.
  const tankById = Object.fromEntries(tanks.map((t) => [t.id, t])) as Record<string, Equipment | undefined>;
  const currentTankByBatchId: Record<string, Equipment | undefined> = Object.fromEntries(
    assignments.map((a) => [a.batch_id, tankById[a.tank_id]])
  );
```

- [ ] **Step 4: Add Up Next direct-action state and the action resolver**

Still in `BrewStatusTab.tsx`, the Up Next banner currently does `onClick={() => e.equipment_id && setPlansEquipmentId(e.equipment_id)}` (around line 357) for every entry uniformly. Replace this with a per-entry resolved action.

Add, near the other transfer-related state (around line 109-111, alongside `transferTankId`/`transferBatchId`/`transferFromVol`):

```tsx
  // When the Up Next banner opens the Transfer modal directly (rather than
  // the per-tank Transfer button), it may need to seed Convert-mode fields.
  const [transferInitialDestId, setTransferInitialDestId] = useState<string | undefined>(undefined);
  const [transferInitialMode, setTransferInitialMode] = useState<"transfer" | "convert" | undefined>(undefined);
  const [transferInitialConvert, setTransferInitialConvert] = useState<{ recipeId: string; beerName: string; bbl: string } | undefined>(undefined);
```

Add a resolver function near `upcomingTasks` (after its definition):

```tsx
  // Resolve the right click-through action for an Up Next card: prefer a
  // direct Transfer/Convert action over the tank's current occupant, falling
  // back to the read-only "Upcoming plans" popup when there's no current
  // tank to act from (e.g. the batch hasn't been brewed/placed yet).
  function openUpNextAction(e: ScheduleEntry) {
    const currentTank = currentTankByBatchId[e.batch_id];
    if (!currentTank) {
      if (e.equipment_id) setPlansEquipmentId(e.equipment_id);
      return;
    }
    if (e.stage === "planned_conversion") {
      let conversionInfo: { beer_name?: string; child_batch_id?: string } = {};
      try { conversionInfo = JSON.parse(e.notes ?? "{}"); } catch { /* malformed/missing notes — fall back to blanks */ }
      const childBatch = conversionInfo.child_batch_id ? batchById[conversionInfo.child_batch_id] : undefined;
      setTransferTankId(currentTank.id);
      setTransferBatchId(e.batch_id);
      setTransferFromVol(undefined);
      setTransferInitialMode("convert");
      setTransferInitialDestId(undefined);
      setTransferInitialConvert({
        recipeId: childBatch?.recipe_id ?? "",
        beerName: conversionInfo.beer_name ?? "",
        bbl: e.volume_bbl != null ? String(e.volume_bbl) : "",
      });
      return;
    }
    // In-place fermenting→conditioning, or any other transfer to a specific
    // planned tank: open Transfer mode with that tank pre-selected as the
    // destination (TransferModal falls back to its own first-valid-option
    // default if this tank isn't actually a legal destination).
    setTransferTankId(currentTank.id);
    setTransferBatchId(e.batch_id);
    setTransferFromVol(undefined);
    setTransferInitialMode("transfer");
    setTransferInitialDestId(e.equipment_id ?? undefined);
    setTransferInitialConvert(undefined);
  }
```

- [ ] **Step 5: Wire the Up Next card to call the resolver, with stage-aware button copy**

Replace the Up Next card's `onClick` and add an action label. Find the card render (around lines 350-375):

```tsx
            {upcomingTasks.slice(0, 10).map((e) => {
              const b = e.brew_batches ?? (e.batch_id ? batchById[e.batch_id] : null);
              const eqName = e.equipment?.name ?? tanks.find(t => t.id === e.equipment_id)?.name ?? "—";
              const overdue = e.planned_start.slice(0, 10) < new Date().toISOString().slice(0, 10);
              return (
                <button
                  key={e.id}
                  onClick={() => e.equipment_id && setPlansEquipmentId(e.equipment_id)}
                  className={`shrink-0 flex flex-col gap-0.5 text-left px-2.5 py-1.5 rounded border transition-colors min-w-[150px] ${
                    overdue
                      ? "border-red-800/60 bg-red-950/30 hover:bg-red-950/50"
                      : "border-zinc-700/60 bg-zinc-800/40 hover:bg-zinc-800/70"
                  }`}
                >
                  <span className={`text-[9px] font-semibold uppercase tracking-wide ${overdue ? "text-red-400" : "text-amber-500"}`}>
                    {STAGE_LABELS[e.stage] ?? e.stage} · {eqName}
                  </span>
                  <span className="text-xs text-zinc-200 truncate">
                    {b ? `#${b.batch_number} ${b.beer_name}` : "—"}
                  </span>
                  <span className="text-[10px] text-zinc-500">
                    {fmtDate(e.planned_start)}{e.volume_bbl != null && ` · ${Number(e.volume_bbl).toFixed(1)} BBL`}
                  </span>
                </button>
              );
            })}
```

Replace with:

```tsx
            {upcomingTasks.slice(0, 10).map((e) => {
              const b = e.brew_batches ?? (e.batch_id ? batchById[e.batch_id] : null);
              const eqName = e.equipment?.name ?? tanks.find(t => t.id === e.equipment_id)?.name ?? "—";
              const overdue = e.planned_start.slice(0, 10) < new Date().toISOString().slice(0, 10);
              const currentTank = currentTankByBatchId[e.batch_id];
              const actionLabel = !currentTank
                ? null
                : e.stage === "planned_conversion"
                ? "Convert"
                : e.stage === "conditioning" && e.equipment_id === currentTank.id
                ? "Confirm Conditioning"
                : "Transfer";
              return (
                <button
                  key={e.id}
                  onClick={() => openUpNextAction(e)}
                  className={`shrink-0 flex flex-col gap-0.5 text-left px-2.5 py-1.5 rounded border transition-colors min-w-[150px] ${
                    overdue
                      ? "border-red-800/60 bg-red-950/30 hover:bg-red-950/50"
                      : "border-zinc-700/60 bg-zinc-800/40 hover:bg-zinc-800/70"
                  }`}
                >
                  <span className={`text-[9px] font-semibold uppercase tracking-wide ${overdue ? "text-red-400" : "text-amber-500"}`}>
                    {STAGE_LABELS[e.stage] ?? e.stage} · {eqName}
                  </span>
                  <span className="text-xs text-zinc-200 truncate">
                    {b ? `#${b.batch_number} ${b.beer_name}` : "—"}
                  </span>
                  <span className="text-[10px] text-zinc-500">
                    {fmtDate(e.planned_start)}{e.volume_bbl != null && ` · ${Number(e.volume_bbl).toFixed(1)} BBL`}
                  </span>
                  {actionLabel && (
                    <span className="text-[9px] text-amber-600 font-medium mt-0.5">{actionLabel} →</span>
                  )}
                </button>
              );
            })}
```

- [ ] **Step 6: Pass the new initial-state props through to `TransferModal`, and reset them on close**

Find the `TransferModal` render block (around lines 1294-1308):

```tsx
      {/* Transfer modal */}
      {transferTankId && transferTank && transferBatch && (
        <TransferModal
          batch={transferBatch}
          fromTank={transferTank}
          allTanks={tanks}
          occupiedTankIds={new Set(assignments.map((a) => a.tank_id))}
          occupiedTankRecipeIds={occupiedTankRecipeIds}
          packaging={packaging}
          recipes={recipes}
          fromTankVolume={transferFromVol}
          plannedEntry={transferPlannedEntry}
          onClose={() => { setTransferTankId(null); setTransferBatchId(null); setTransferFromVol(undefined); }}
          onDone={handleTransferDone}
        />
      )}
```

Replace with:

```tsx
      {/* Transfer modal */}
      {transferTankId && transferTank && transferBatch && (
        <TransferModal
          batch={transferBatch}
          fromTank={transferTank}
          allTanks={tanks}
          occupiedTankIds={new Set(assignments.map((a) => a.tank_id))}
          occupiedTankRecipeIds={occupiedTankRecipeIds}
          packaging={packaging}
          recipes={recipes}
          fromTankVolume={transferFromVol}
          plannedEntry={transferPlannedEntry}
          initialDestId={transferInitialDestId}
          initialMode={transferInitialMode}
          initialConvert={transferInitialConvert}
          onClose={() => {
            setTransferTankId(null);
            setTransferBatchId(null);
            setTransferFromVol(undefined);
            setTransferInitialDestId(undefined);
            setTransferInitialMode(undefined);
            setTransferInitialConvert(undefined);
          }}
          onDone={handleTransferDone}
        />
      )}
```

- [ ] **Step 7: Verify build**

Run: `npm run lint && npm run build`
Expected: no errors.

- [ ] **Step 8: Manual verification of each transition type**

Start `npm run dev`, open `/production/brewing/floorplan`. For this to be testable you need schedule entries in various stages — use whatever existing batches/schedule entries are available in the dev database, or create one via "New Batch" + the EquipmentSchedule tab's planning UI if none exist. Check:
- An Up Next card for a batch currently in a fermenter, with its next entry being "Conditioning" in the *same* tank → card shows "Confirm Conditioning →"; clicking opens `TransferModal` with that tank pre-selected as destination (stay-in-place).
- An Up Next card for a batch with its next entry in a *different* tank (e.g. fermenter → brite) → card shows "Transfer →"; clicking opens `TransferModal` with the planned tank pre-selected as destination.
- If a `planned_conversion` marker exists (create one via the EquipmentSchedule tab's Convert panel if none exist) → it now appears in Up Next (previously hidden), showing "Convert →"; clicking opens `TransferModal` already in Convert mode with recipe/beer name/volume pre-filled.
- A batch still in `planning` status with no tank assignment yet → its Up Next entry (if any) falls back to opening the read-only "Upcoming plans" popup, unchanged from before.

- [ ] **Step 9: Commit**

```bash
git add app/production/components/TransferModal.tsx app/production/components/BrewStatusTab.tsx
git commit -m "Wire Up Next banner to open the right direct action per stage transition"
```

---

## Plan Self-Review

**Spec coverage:**
- Spec §1 (empty-tank bar + Next planned alignment) → Task 4.
- Spec §2 (Transfer modal spacing) → Task 5.
- Spec §3 (Up Next direct actions, all transitions) → Task 6.
- Spec §4 (drag bug + quarter-cell grid) → Tasks 1 (resolution/migration) and 2 (drag math fix).
- Spec §5 (legend/Edit Layout merge + max zoom) → Task 3.
- Spec's "Out of scope" notes (no new API routes, no model changes beyond the grid migration) are respected — Task 6 reuses the existing `/api/production/conversions` and `/api/production/transfers` routes via the existing `TransferModal` submit logic, unchanged.

**Placeholder scan:** no TBD/TODO; every step shows complete code; the one genuine ambiguity found during research (planned_conversion entries being excluded from Up Next, and their `equipment_id` pointing at the source tank rather than a destination) is called out explicitly in Task 6's background note and handled in the `openUpNextAction` resolver rather than left as an open question.

**Type consistency:** `TransferModal`'s new props (`initialDestId`, `initialMode`, `initialConvert`) are introduced once in Task 6 Step 1 and consumed with matching names/types in Task 6 Steps 4-6 (`transferInitialDestId: string | undefined`, `transferInitialMode: "transfer" | "convert" | undefined`, `transferInitialConvert: { recipeId: string; beerName: string; bbl: string } | undefined`). `NextPlannedBox`'s prop names (`batchNumber`, `beerName`, `plannedStart`, `volumeBbl`, `size`) are identical across all three call sites in Task 4. `useTankDragDrop`'s new third parameter `gridScale: number` is added once in Task 2 and its only caller is updated in the same task.
