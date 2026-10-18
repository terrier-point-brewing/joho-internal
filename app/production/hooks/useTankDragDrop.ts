"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Equipment } from "../types";
import { GRID_CELL_PX as CELL } from "@/lib/constants/production";
import { queryKeys } from "@/lib/query-keys";

// Pointer-event drag for the floorplan grid. Native HTML5 drag-and-drop was
// replaced because (a) `dragleave` fires when the cursor crosses a child tile,
// which wiped the preview mid-drag, (b) Chrome draws the drag ghost at the
// unscaled size under the grid's CSS `scale()` wrapper, so it never tracked
// the hand, and (c) a drop over any overlap silently did nothing. Now the tile
// itself follows the pointer, the landing cell snaps to the nearest free spot,
// and the move is applied optimistically before the PATCH round-trips.

// Bounds must be checked against the actual rendered grid size (the
// admin-configurable gridCols/gridRows, which can differ from the
// GRID_COLS/GRID_ROWS defaults), not the fixed constants — otherwise a
// "valid" drop can land outside the visible, overflow-hidden container.
function isInBounds(t: Equipment, row: number, col: number, gridCols: number, gridRows: number): boolean {
  return row >= 0 && col >= 0 && row + t.grid_height <= gridRows && col + t.grid_width <= gridCols;
}

function wouldCollide(tanks: Equipment[], drag: Equipment, row: number, col: number): boolean {
  return tanks
    .filter((t) => t.id !== drag.id && t.grid_row != null && t.grid_col != null)
    .some((t) => {
      const tr = t.grid_row!, tc = t.grid_col!;
      return !(col + drag.grid_width <= tc || col >= tc + t.grid_width ||
               row + drag.grid_height <= tr || row >= tr + t.grid_height);
    });
}

// How far (in cells) a drop looks for a free spot before giving up and
// reporting the pointer's own cell as invalid.
const SNAP_RADIUS = 3;
// Pointer travel before a press turns into a drag — keeps clicks on tile
// buttons and the tile name from starting a move.
const DRAG_THRESHOLD_PX = 4;

function nearestFree(tanks: Equipment[], drag: Equipment, row: number, col: number, gridCols: number, gridRows: number): { row: number; col: number } | null {
  const ok = (r: number, c: number) => isInBounds(drag, r, c, gridCols, gridRows) && !wouldCollide(tanks, drag, r, c);
  if (ok(row, col)) return { row, col };
  for (let d = 1; d <= SNAP_RADIUS; d++) {
    // Walk the ring at Chebyshev distance d, nearest-first by Euclidean distance.
    const ring: { r: number; c: number }[] = [];
    for (let dr = -d; dr <= d; dr++) for (let dc = -d; dc <= d; dc++) {
      if (Math.max(Math.abs(dr), Math.abs(dc)) === d) ring.push({ r: row + dr, c: col + dc });
    }
    ring.sort((a, b) => ((a.r - row) ** 2 + (a.c - col) ** 2) - ((b.r - row) ** 2 + (b.c - col) ** 2));
    const hit = ring.find(({ r, c }) => ok(r, c));
    if (hit) return { row: hit.r, col: hit.c };
  }
  return null;
}

type Drag = {
  id: string;
  grabRow: number;   // cells from the tile's top-left to where it was grabbed
  grabCol: number;
  startX: number;    // screen px of the press, for the drag threshold
  startY: number;
  active: boolean;   // past the threshold
  fromGrid: boolean; // false when picked up from the Unplaced panel
};

export function useTankDragDrop(tanks: Equipment[], onRefresh: () => Promise<void>, gridScale: number, gridCols: number, gridRows: number) {
  const qc = useQueryClient();
  const [dragging, setDragging] = useState<Drag | null>(null);
  const [dropPreview, setDropPreview] = useState<{ row: number; col: number; valid: boolean } | null>(null);
  // Where the dragged tile is drawn while in flight, in UNSCALED grid px.
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // The grid (and every tile inside it) is rendered through a CSS
  // `transform: scale(gridScale)` wrapper, so `getBoundingClientRect()`
  // reflects the scaled on-screen size while CELL is a fixed, unscaled px
  // value. Every conversion from screen px to grid cells divides by the
  // *effective* on-screen cell size, or the computed row/col drifts from the
  // cursor as soon as the grid is scaled to fit its container.
  const effectiveCell = CELL * (gridScale || 1);

  // Latest values for the window listeners, which are bound once per drag.
  const latest = useRef({ tanks, effectiveCell, gridCols, gridRows, dragging, dropPreview });
  useEffect(() => { latest.current = { tanks, effectiveCell, gridCols, gridRows, dragging, dropPreview }; });

  const clearDrag = useCallback(() => { setDragging(null); setDropPreview(null); setGhost(null); }, []);

  async function patchPosition(tankId: string, row: number | null, col: number | null) {
    // Optimistic: move it in the cache now, reconcile with the server after.
    qc.setQueryData<Equipment[]>(queryKeys.production.equipment(), (old) =>
      old?.map((t) => (t.id === tankId ? { ...t, grid_row: row, grid_col: col } : t)),
    );
    const res = await fetch(`/api/production/equipment/${tankId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grid_row: row, grid_col: col }),
    });
    if (!res.ok) await qc.invalidateQueries({ queryKey: queryKeys.production.equipment() });
    else await onRefresh();
  }

  function onPointerDown(e: React.PointerEvent, t: Equipment, fromGrid: boolean) {
    if (e.button !== 0) return;
    // Buttons and inputs inside a tile keep their own clicks.
    if ((e.target as HTMLElement).closest("button, input, select, textarea, a")) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const grabCol = fromGrid ? Math.floor((e.clientX - rect.left) / effectiveCell) : 0;
    const grabRow = fromGrid ? Math.floor((e.clientY - rect.top)  / effectiveCell) : 0;
    e.preventDefault();
    setDragging({ id: t.id, grabRow, grabCol, startX: e.clientX, startY: e.clientY, active: false, fromGrid });
  }

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const { tanks, effectiveCell, gridCols, gridRows, dragging: d } = latest.current;
      if (!d || !gridRef.current) return;
      if (!d.active) {
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD_PX) return;
        setDragging({ ...d, active: true });
      }
      const tank = tanks.find((t) => t.id === d.id);
      if (!tank) return;
      const rect = gridRef.current.getBoundingClientRect();
      const px = (e.clientX - rect.left) / effectiveCell; // pointer, in cells (fractional)
      const py = (e.clientY - rect.top)  / effectiveCell;
      setGhost({ x: (px - d.grabCol) * CELL, y: (py - d.grabRow) * CELL });
      const outside = e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom;
      if (outside) { setDropPreview(null); return; }
      const col = Math.round(px - d.grabCol);
      const row = Math.round(py - d.grabRow);
      const snap = nearestFree(tanks, tank, row, col, gridCols, gridRows);
      setDropPreview(snap ? { ...snap, valid: true } : { row, col, valid: false });
    };
    const up = async () => {
      const { dragging: d, dropPreview: p, tanks } = latest.current;
      clearDrag();
      if (!d || !d.active) return;
      const tank = tanks.find((t) => t.id === d.id);
      if (!tank) return;
      if (p?.valid) {
        if (p.row !== tank.grid_row || p.col !== tank.grid_col) await patchPosition(d.id, p.row, p.col);
      } else if (!p && d.fromGrid) {
        // Dropped off the grid: unplace it.
        await patchPosition(d.id, null, null);
      }
    };
    const cancel = () => clearDrag();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging?.id]);

  async function removeFromGrid(tankId: string) {
    await patchPosition(tankId, null, null);
  }

  const draggingTank = dragging?.active ? tanks.find((t) => t.id === dragging.id) ?? null : null;

  return {
    // `dragging` is only reported once the press has become a real drag.
    dragging: dragging?.active ? { id: dragging.id } : null,
    dropPreview, gridRef, draggingTank, ghost,
    onPointerDown, removeFromGrid, clearDrag,
  };
}
