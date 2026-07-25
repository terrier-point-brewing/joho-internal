"use client";

import React, { useState, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  format, addDays, differenceInDays, parseISO,
  startOfToday, subDays,
} from "date-fns";
import { Equipment } from "../types";
import { useBatchScheduleQuery, useEquipmentQuery, useBatchesQuery, useScheduleConflictsQuery, productionKeys, type ScheduleEntry, type ScheduleConflict } from "../hooks/queries";
import { BATCH_PALETTE, CATEGORY_FALLBACK_HEX, EQUIPMENT_TYPE_ACCENT_HEX as TYPE_ACCENT } from "../lib/categoryColors";

const EQUIPMENT_STAGE_ORDER = ["brewhouse", "fermenter", "brite", "canning", "kegging"];
const STAGE_LABELS: Record<string, string> = {
  brewhouse:    "Brewing",
  fermenter:    "Fermenting",
  fermenting:   "Fermenting",
  conditioning: "Conditioning",
  kegging:      "Kegging",
  canning:      "Canning",
  cold_storage: "Cold Storage",
};

const RANGE_OPTIONS = [
  { label: "2W", days: 14 },
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
  { label: "6M", days: 180 },
];

// Toolbar toggle chips (range / flow / batch filter). Not `.btn-*` — these are
// persistent on/off state chips, not actions — so they carry their own token-backed
// on/off pair. The three "on" hues stay visually distinct (accent / violet / blue)
// but bind to theme-flipping tokens, so the toolbar reads on the light brand skin too.
const TOGGLE_ON = {
  accent: "bg-accent-muted text-accent border-accent-border",
  violet: "bg-[var(--cat-violet-bg)] text-[var(--cat-violet-fg)] border-[var(--cat-violet-bd)]",
  blue:   "bg-[var(--cat-blue-bg)] text-[var(--cat-blue-fg)] border-[var(--cat-blue-bd)]",
} as const;
const TOGGLE_OFF = "bg-surface-mid text-secondary border-transparent hover:text-strong";

const ROW_H = 44;
const LABEL_W = 180;
const DAY_PX_BASE: Record<number, number> = { 14: 48, 30: 28, 90: 12, 180: 7 };

export default function GanttTab() {
  const qc = useQueryClient();
  const { data: equipment = [] } = useEquipmentQuery();
  const { data: batches = [] } = useBatchesQuery();
  const { data: entries = [] } = useBatchScheduleQuery();
  const { data: conflicts = [] } = useScheduleConflictsQuery();
  const [rangeIdx, setRangeIdx] = useState(2);
  // Noon-anchor viewStart so differenceInDays comparisons against noon bar dates are always integers.
  const [viewStart, setViewStart] = useState(() => {
    const d = subDays(startOfToday(), 3);
    return parseISO(format(d, "yyyy-MM-dd") + "T12:00:00");
  });
  const [dismissedConflicts, setDismissedConflicts] = useState<Set<string>>(new Set());
  const [resolvingConflict, setResolvingConflict] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [showFlow, setShowFlow] = useState(false);
  const [filteredBatchIds, setFilteredBatchIds] = useState<Set<string> | null>(null); // null = all
  const [showBatchFilter, setShowBatchFilter] = useState(false);

  const rangeDays = RANGE_OPTIONS[rangeIdx].days;
  const dayPx = DAY_PX_BASE[rangeDays] ?? 12;
  const totalDays = rangeDays;
  const viewEnd = addDays(viewStart, totalDays);

  const reloadSchedule = () => {
    qc.invalidateQueries({ queryKey: productionKeys.batchSchedule });
    qc.invalidateQueries({ queryKey: productionKeys.scheduleConflicts });
  };

  async function applyConflictFix(conflict: ScheduleConflict) {
    if (!conflict.suggested_resolution) return;
    const { equipment_id, new_start, new_end } = conflict.suggested_resolution;
    setResolvingConflict(conflict.id);
    try {
      await fetch(`/api/production/batch-schedule/${conflict.entry_b.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ equipment_id, planned_start: new_start, planned_end: new_end }),
      });
      await reloadSchedule();
      setDismissedConflicts(prev => { const s = new Set(prev); s.add(conflict.id); return s; });
    } finally {
      setResolvingConflict(null);
    }
  }

  // Group equipment by type, preserving only schedulable types
  const equipmentByType = useMemo(() => {
    const map: Record<string, Equipment[]> = {};
    for (const eq of equipment) {
      if (!EQUIPMENT_STAGE_ORDER.includes(eq.type)) continue;
      if (!map[eq.type]) map[eq.type] = [];
      map[eq.type].push(eq);
    }
    return map;
  }, [equipment]);

  // Set of conflicted entry IDs (used for red-ring highlight on bars)
  const conflictedEntryIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of conflicts) { ids.add(c.entry_a.id); ids.add(c.entry_b.id); }
    return ids;
  }, [conflicts]);

  // Build flat row list: one row per equipment piece
  const rows = useMemo(() => {
    const result: { eq: Equipment; typeLabel: string; isFirst: boolean }[] = [];
    for (const type of EQUIPMENT_STAGE_ORDER) {
      const eqs = equipmentByType[type] ?? [];
      eqs.forEach((eq, i) => result.push({ eq, typeLabel: STAGE_LABELS[type] ?? type, isFirst: i === 0 }));
    }
    return result;
  }, [equipmentByType]);

  // Batch color map (stable)
  const batchColors = useMemo(() => {
    const map: Record<string, string> = {};
    batches.forEach((b, i) => { map[b.id] = BATCH_PALETTE[i % BATCH_PALETTE.length]; });
    return map;
  }, [batches]);

  // Filtered entries (null = show all)
  const visibleEntries = useMemo(() =>
    filteredBatchIds ? entries.filter((e) => e.batch_id && filteredBatchIds.has(e.batch_id)) : entries,
  [entries, filteredBatchIds]);

  // Equipment row Y positions (for flow connector arrows).
  // Layout: 40px chart header; then for each type: 24px group header + n×ROW_H rows.
  const equipRowY = useMemo(() => {
    const map: Record<string, number> = {};
    let y = 40; // chart header
    for (const type of EQUIPMENT_STAGE_ORDER) {
      const eqs = equipmentByType[type] ?? [];
      if (!eqs.length) continue;
      y += 24; // group header
      eqs.forEach((eq) => { map[eq.id] = y; y += ROW_H; });
    }
    return map;
  }, [equipmentByType]);

  // Flow connectors: for each batch, sort entries by planned_start and draw an
  // arrow from the right edge of entry[i] to the left edge of entry[i+1].
  const flowConnectors = useMemo(() => {
    if (!showFlow) return [];
    const byBatch: Record<string, ScheduleEntry[]> = {};
    for (const e of visibleEntries) {
      if (!e.batch_id || !e.equipment_id) continue;
      (byBatch[e.batch_id] ??= []).push(e);
    }
    const paths: { d: string; color: string; key: string }[] = [];
    for (const [batchId, bEntries] of Object.entries(byBatch)) {
      const sorted = [...bEntries].sort((a, b) => a.planned_start.localeCompare(b.planned_start));
      const color = batchColors[batchId] ?? CATEGORY_FALLBACK_HEX;
      for (let i = 0; i < sorted.length - 1; i++) {
        const a = sorted[i], b = sorted[i + 1];
        if (!a.equipment_id || !b.equipment_id) continue;
        const aEndOffset = differenceInDays(parseISO(a.planned_end.slice(0, 10) + "T12:00:00"), viewStart);
        const bStartOffset = differenceInDays(parseISO(b.planned_start.slice(0, 10) + "T12:00:00"), viewStart);
        if (aEndOffset < 0 && bStartOffset < 0) continue;
        if (aEndOffset > totalDays && bStartOffset > totalDays) continue;
        const x1 = LABEL_W + aEndOffset * dayPx;
        const x2 = LABEL_W + bStartOffset * dayPx;
        const y1 = (equipRowY[a.equipment_id] ?? 0) + ROW_H / 2;
        const y2 = (equipRowY[b.equipment_id] ?? 0) + ROW_H / 2;
        const dx = Math.abs(x2 - x1) * 0.4;
        paths.push({
          key: `${a.id}-${b.id}`,
          color,
          d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`,
        });
      }
    }
    return paths;
  }, [showFlow, visibleEntries, batchColors, viewStart, dayPx, totalDays, equipRowY]);

  function entryBar(entry: ScheduleEntry, eqId: string) {
    if (entry.equipment_id !== eqId) return null;
    const isConflicted = conflictedEntryIds.has(entry.id);
    const color = (entry.batch_id ? batchColors[entry.batch_id] : null) ?? CATEGORY_FALLBACK_HEX;
    const label = entry.brew_batches
      ? `#${entry.brew_batches.batch_number} · ${entry.brew_batches.beer_name}`
      : "?";
    // Noon-anchor today so differenceInDays is always an integer relative to other
    // noon-anchored dates, keeping the solid fill aligned to the today marker.
    const today = parseISO(format(startOfToday(), "yyyy-MM-dd") + "T12:00:00");

    // Append T12:00:00 so local-time format() always resolves to the correct
    // calendar date regardless of the user's UTC offset.
    const pStart = parseISO(entry.planned_start.slice(0, 10) + "T12:00:00");
    const pEnd   = parseISO(entry.planned_end.slice(0, 10) + "T12:00:00");
    const aStart = entry.actual_start ? parseISO(entry.actual_start.slice(0, 10) + "T12:00:00") : null;
    const aEnd   = entry.actual_end   ? parseISO(entry.actual_end.slice(0, 10) + "T12:00:00")   : null;

    // Unified bar: always spans barStart→barEnd as one visual element.
    // "Split point" separates the solid (actual/elapsed) left from the dashed (planned/remaining) right.
    const barStart    = aStart ?? pStart;
    const barEnd      = pEnd;
    const splitPoint  = aEnd ?? (aStart ? today : null); // where solid ends

    const barOffset = differenceInDays(barStart, viewStart);
    const barWidth  = Math.max(differenceInDays(barEnd, barStart), 1);
    if (barOffset > totalDays || barOffset + barWidth < 0) return null;

    const rawLeft  = barOffset * dayPx;
    const rawRight = rawLeft + barWidth * dayPx;

    // Clip the bar to the visible window [0, totalDays * dayPx]
    const displayLeft  = Math.max(rawLeft, 0);
    const displayRight = Math.min(rawRight, totalDays * dayPx);
    if (displayLeft >= displayRight) return null;
    const barLeft = displayLeft;
    const barPx   = Math.max(displayRight - displayLeft, 6);

    // Solid portion: compute in raw space then map to clipped percentage
    const solidDays = splitPoint
      ? Math.min(Math.max(differenceInDays(splitPoint, barStart), 0), barWidth)
      : 0;
    const solidRawRight = rawLeft + solidDays * dayPx;
    const solidClipped  = Math.max(Math.min(solidRawRight, displayRight), displayLeft);
    const solidPct  = barPx > 0 ? ((solidClipped - displayLeft) / barPx) * 100 : 0;
    const hasSolid  = solidPct > 0;

    const tooltipParts = [label];
    if (aStart && aEnd) tooltipParts.push(`Actual: ${format(aStart, "MMM d")} – ${format(aEnd, "MMM d")}`);
    else if (aStart)    tooltipParts.push(`Started: ${format(aStart, "MMM d")} (in progress)`);
    tooltipParts.push(`Planned: ${format(pStart, "MMM d")} – ${format(pEnd, "MMM d")}`);
    if (entry.notes) tooltipParts.push(entry.notes);

    return (
      <div
        key={entry.id}
        title={tooltipParts.join("\n")}
        className="absolute top-1.5 bottom-1.5 overflow-hidden select-none flex items-center"
        style={{
          left: Math.max(barLeft, 0), width: Math.max(barPx, 6), borderRadius: 4,
          border: isConflicted
            ? `2px solid var(--color-danger-emphasis)`
            : `1.5px solid ${color}`,
          // Dashed right border = end date is unconfirmed (no downstream chain + not yet ended)
          borderRight: (!entry.downstream_entry_id && !entry.actual_end && !isConflicted)
            ? `1.5px dashed ${color}`
            : undefined,
          boxShadow: isConflicted
            ? "0 0 0 2px color-mix(in srgb, var(--color-danger-emphasis) 38%, transparent)"
            : undefined,
        }}
      >
        {/* Solid (actual / elapsed) left portion */}
        {hasSolid && (
          <div
            className="absolute top-0 bottom-0 left-0"
            style={{ width: `${solidPct}%`, background: color, opacity: 0.92 }}
          />
        )}
        {/* Translucent (planned / remaining) right portion */}
        <div
          className="absolute top-0 bottom-0"
          style={{
            left:  `${solidPct}%`,
            right: 0,
            background: hasSolid ? `${color}28` : `${color}40`,
          }}
        />
        {/* Label — always visible, sits above both portions */}
        {barPx > 28 && (
          // Bar fills are saturated batch hues in both themes, so the label rides the
          // theme's own primary text color with a canvas-colored halo: light glyph +
          // dark halo on the dark app, dark glyph + light halo under the light skin.
          <span
            className="relative z-10 px-2 text-xs font-medium text-primary truncate w-full"
            style={{ textShadow: "0 1px 2px var(--color-canvas)" }}
          >
            {label}
          </span>
        )}
      </div>
    );
  }

  // Build header day labels (only show every N days depending on range)
  const labelEvery = rangeDays <= 14 ? 1 : rangeDays <= 30 ? 3 : rangeDays <= 90 ? 7 : 14;
  const dayLabels: { day: number; date: Date }[] = [];
  for (let d = 0; d < totalDays; d++) {
    if (d % labelEvery === 0) dayLabels.push({ day: d, date: addDays(viewStart, d) });
  }

  const todayOffset = differenceInDays(parseISO(format(startOfToday(), "yyyy-MM-dd") + "T12:00:00"), viewStart);

  return (
    <div>
      {/* Mobile placeholder */}
      <div className="md:hidden flex flex-col items-center justify-center py-16 px-6 text-center">
        <p className="text-secondary font-medium mb-1">Timeline view is desktop-only</p>
        <p className="text-sm text-faint">Open this page on a larger screen to view and manage the equipment schedule Gantt chart.</p>
      </div>

      <div className="hidden md:block">
      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <div className="flex gap-1">
          {RANGE_OPTIONS.map((o, i) => (
            <button
              key={o.label}
              onClick={() => setRangeIdx(i)}
              className={`px-3 py-1 text-xs rounded font-medium border transition-colors ${rangeIdx === i ? TOGGLE_ON.accent : TOGGLE_OFF}`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          <button onClick={() => setViewStart(d => subDays(d, Math.floor(rangeDays / 3)))} className="px-2 py-1 text-xs bg-surface-mid rounded text-secondary hover:text-strong">‹</button>
          <button onClick={() => { const d = subDays(startOfToday(), 3); setViewStart(parseISO(format(d, "yyyy-MM-dd") + "T12:00:00")); }} className="px-3 py-1 text-xs bg-surface-mid rounded text-secondary hover:text-strong">Today</button>
          <button onClick={() => setViewStart(d => addDays(d, Math.floor(rangeDays / 3)))} className="px-2 py-1 text-xs bg-surface-mid rounded text-secondary hover:text-strong">›</button>
        </div>
        <span className="text-xs text-muted">{format(viewStart, "MMM d")} – {format(viewEnd, "MMM d, yyyy")}</span>

        {/* Flow toggle */}
        <button
          onClick={() => setShowFlow((v) => !v)}
          className={`px-3 py-1 text-xs rounded font-medium border transition-colors ${showFlow ? TOGGLE_ON.violet : TOGGLE_OFF}`}
          title="Show/hide batch flow arrows between stages"
        >
          {showFlow ? "⇢ Flow on" : "⇢ Flow"}
        </button>

        {/* Batch filter */}
        <div className="relative">
          <button
            onClick={() => setShowBatchFilter((v) => !v)}
            className={`px-3 py-1 text-xs rounded font-medium border transition-colors ${filteredBatchIds ? TOGGLE_ON.blue : TOGGLE_OFF}`}
          >
            Filter{filteredBatchIds ? ` (${filteredBatchIds.size})` : ""}
          </button>
          {showBatchFilter && (
            <div className="absolute top-8 left-0 z-50 bg-surface border border-line-strong rounded-lg shadow-xl p-2 min-w-[220px] max-h-72 overflow-y-auto">
              <div className="flex items-center justify-between mb-2 px-1">
                <span className="text-xs font-semibold text-secondary">Filter by Batch</span>
                <button onClick={() => { setFilteredBatchIds(null); setShowBatchFilter(false); }}
                  className="text-2xs text-muted hover:text-body">Clear</button>
              </div>
              {batches.map((b, i) => {
                const color = BATCH_PALETTE[i % BATCH_PALETTE.length];
                const selected = filteredBatchIds ? filteredBatchIds.has(b.id) : true;
                return (
                  <label key={b.id} className="flex items-center gap-2 px-1 py-1 rounded hover:bg-surface-mid cursor-pointer">
                    <input type="checkbox" checked={selected} onChange={(e) => {
                      setFilteredBatchIds((prev) => {
                        const base = prev ?? new Set(batches.map((x) => x.id));
                        const next = new Set(base);
                        if (e.target.checked) next.add(b.id); else next.delete(b.id);
                        return next.size === batches.length ? null : next.size === 0 ? prev : next;
                      });
                    }} className="sr-only" />
                    <span
                      className="w-2.5 h-2.5 rounded-sm flex-none"
                      style={{ background: selected ? color : "var(--color-surface-high)" }}
                    />
                    <span className={`text-xs truncate ${selected ? "text-strong" : "text-faint"}`}>
                      #{b.batch_number} {b.beer_name}
                    </span>
                  </label>
                );
              })}
              <button onClick={() => setShowBatchFilter(false)} className="mt-2 w-full text-xs text-muted hover:text-body py-1">Done</button>
            </div>
          )}
        </div>

        {/* Bar legend */}
        <div className="ml-auto flex items-center gap-4">
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <div className="w-8 h-3 rounded-sm flex-none border border-dashed border-[var(--color-text-secondary)] bg-surface-high/30" />
            Planned
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <div className="w-8 h-3 rounded-sm flex-none bg-[var(--color-text-secondary)]" />
            Actual
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <div className="w-8 h-3 rounded-sm flex-none" style={{
              border: "1.5px solid var(--color-text-secondary)",
              borderRight: "1.5px dashed var(--color-text-secondary)",
            }} />
            End unconfirmed
          </div>
        </div>
      </div>

      {/* Batch color legend */}
      {batches.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 mb-3 px-0.5">
          {batches.slice(0, 12).map((b, i) => (
            <div key={b.id} className="flex items-center gap-1.5 text-xs text-secondary">
              <div className="w-3 h-3 rounded-sm flex-none" style={{ background: BATCH_PALETTE[i % BATCH_PALETTE.length] }} />
              #{b.batch_number} {b.beer_name}
            </div>
          ))}
        </div>
      )}

      {/* Conflict Banner */}
      {conflicts.filter(c => !dismissedConflicts.has(c.id)).length > 0 && (
        <div className="mb-4 rounded-lg border border-danger-border bg-danger-surface/40 px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold text-danger">
              ⚠ {conflicts.filter(c => !dismissedConflicts.has(c.id)).length} Schedule Conflict{conflicts.filter(c => !dismissedConflicts.has(c.id)).length > 1 ? "s" : ""} Detected
            </span>
          </div>
          <div className="space-y-2">
            {conflicts.filter(c => !dismissedConflicts.has(c.id)).map(conflict => (
              <div key={conflict.id} className="flex items-start justify-between gap-3 text-xs text-body bg-danger-border/20 rounded px-3 py-2">
                <div>
                  <span className="font-medium text-danger">
                    {conflict.equipment.name ?? "Unknown equipment"}:
                  </span>{" "}
                  <span className="font-medium">#{conflict.entry_a.batch_number} {conflict.entry_a.beer_name}</span>
                  {" "}overlaps{" "}
                  <span className="font-medium">#{conflict.entry_b.batch_number} {conflict.entry_b.beer_name}</span>
                  {conflict.suggested_resolution && (
                    <span className="ml-1 text-secondary">
                      · Suggest: move #{conflict.entry_b.batch_number} to <span className="text-strong">{conflict.suggested_resolution.equipment_name}</span>
                    </span>
                  )}
                </div>
                <div className="flex gap-2 flex-none">
                  {conflict.suggested_resolution && (
                    <button
                      onClick={() => applyConflictFix(conflict)}
                      disabled={resolvingConflict === conflict.id}
                      className="btn-primary btn-xxs"
                    >
                      {resolvingConflict === conflict.id ? "…" : "Apply Fix"}
                    </button>
                  )}
                  <button
                    onClick={() => setDismissedConflicts(prev => { const s = new Set(prev); s.add(conflict.id); return s; })}
                    className="btn-secondary btn-xxs"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Gantt */}
      <div className="relative border border-line-strong rounded-lg overflow-auto bg-surface" ref={containerRef}>
        {/* Header */}
        <div className="flex sticky top-0 z-10 bg-surface border-b border-line-strong">
          <div className="flex-none bg-surface border-r border-line-strong text-xs text-muted font-medium flex items-end px-3 pb-2" style={{ width: LABEL_W }}>Equipment</div>
          <div className="relative flex-none" style={{ width: totalDays * dayPx, height: 40 }}>
            {dayLabels.map(({ day, date }) => (
              <div key={day} className="absolute bottom-2 text-xs text-muted" style={{ left: day * dayPx + 2 }}>
                {format(date, rangeDays <= 30 ? "MMM d" : "MMM d")}
              </div>
            ))}
            {/* Today marker header */}
            {todayOffset >= 0 && todayOffset <= totalDays && (
              <div className="absolute top-0 bottom-0 w-px bg-accent-emphasis/60" style={{ left: todayOffset * dayPx }} />
            )}
          </div>
        </div>

        {/* Rows — grouped by equipment type with colored section headers */}
        {rows.length === 0 ? (
          <div className="px-4 py-8 text-sm text-muted text-center">No schedulable equipment found. Add equipment in the Floorplan tab.</div>
        ) : EQUIPMENT_STAGE_ORDER.flatMap((type) => {
          const eqs = equipmentByType[type] ?? [];
          if (!eqs.length) return [];
          const accent = TYPE_ACCENT[type] ?? CATEGORY_FALLBACK_HEX;
          const label  = STAGE_LABELS[type === "brite" ? "conditioning" : type] ?? type;
          return [
            /* Group header row */
            <div key={`hdr-${type}`} className="flex border-b border-line/80 sticky top-[40px] z-10" style={{ borderLeft: `3px solid ${accent}` }}>
              <div
                className="flex-none border-r border-line-strong bg-surface px-3 flex items-center"
                style={{ width: LABEL_W - 3, height: 24 }}
              >
                <span className="text-2xs font-semibold uppercase tracking-widest" style={{ color: accent }}>{label}</span>
              </div>
              <div className="flex-none" style={{ width: totalDays * dayPx, height: 24, background: `${accent}08` }} />
            </div>,
            /* Equipment rows */
            ...eqs.map((eq) => (
              <div key={eq.id} className="flex border-b border-line last:border-0">
                <div className="flex-none border-r border-line-strong px-3 py-1.5 flex items-center" style={{ width: LABEL_W, height: ROW_H }}>
                  <span className="text-xs text-body truncate">{eq.name}</span>
                </div>
                <div className="relative flex-none bg-surface/50" style={{ width: totalDays * dayPx, height: ROW_H }}>
                  {dayLabels.map(({ day }) => (
                    <div key={day} className="absolute top-0 bottom-0 w-px bg-line" style={{ left: day * dayPx }} />
                  ))}
                  {todayOffset >= 0 && todayOffset <= totalDays && (
                    <div className="absolute top-0 bottom-0 w-px bg-accent-emphasis/40" style={{ left: todayOffset * dayPx }} />
                  )}
                  {visibleEntries.map(e => entryBar(e, eq.id))}
                </div>
              </div>
            )),
          ];
        })}

        {/* Flow connector overlay */}
        {showFlow && flowConnectors.length > 0 && (() => {
          const totalH = 40 + EQUIPMENT_STAGE_ORDER.reduce((sum, type) => {
            const eqs = equipmentByType[type] ?? [];
            return sum + (eqs.length ? 24 + eqs.length * ROW_H : 0);
          }, 0);
          return (
            <svg
              className="absolute top-0 left-0 pointer-events-none"
              style={{ width: LABEL_W + totalDays * dayPx, height: totalH }}
            >
              <defs>
                {Object.entries(batchColors).map(([id, color]) => (
                  <marker key={id} id={`arrow-${id}`} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                    <path d="M0,0 L0,6 L6,3 z" fill={color} fillOpacity="0.7" />
                  </marker>
                ))}
              </defs>
              {flowConnectors.map(({ d, color, key }) => {
                const batchId = Object.entries(batchColors).find(([, c]) => c === color)?.[0] ?? "";
                return (
                  <path key={key} d={d} fill="none" stroke={color} strokeWidth="1.5"
                    strokeOpacity="0.65" strokeDasharray="4 2"
                    markerEnd={`url(#arrow-${batchId})`} />
                );
              })}
            </svg>
          );
        })()}
      </div>
      </div>
    </div>
  );
}
