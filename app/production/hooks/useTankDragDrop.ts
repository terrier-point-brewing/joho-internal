"use client";

import React, { useState, useRef, useCallback } from "react";
import { Equipment } from "../types";
import { GRID_CELL_PX as CELL } from "@/lib/constants/production";

// Bounds must be checked against the actual rendered grid size (the
// admin-configurable gridCols/gridRows, which can differ from the
// GRID_COLS/GRID_ROWS defaults), not the fixed constants — otherwise a
// "valid" drop can land outside the visible, overflow-hidden container.
function isInBounds(t: Equipment, row: number, col: number, gridCols: number, gridRows: number): boolean {
  return row >= 0 && col >= 0 && row + t.grid_height <= gridRows && col + t.grid_width <= gridCols;
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

export function useTankDragDrop(tanks: Equipment[], onRefresh: () => Promise<void>, gridScale: number, gridCols: number, gridRows: number) {
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
    const valid = isInBounds(tank, row, col, gridCols, gridRows) && !wouldCollide(tanks, dragging.id, row, col);
    setDropPreview({ row, col, valid });
  }, [dragging, tanks, effectiveCell, gridCols, gridRows]);

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
    if (tank && isInBounds(tank, row, col, gridCols, gridRows) && !wouldCollide(tanks, tankId, row, col)) {
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
