"use client";

import React, { useState, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  format, addDays, differenceInDays, parseISO,
  startOfToday, subDays,
} from "date-fns";
import { Equipment } from "../types";
import { Modal, Field } from "./shared";
import { useBatchScheduleQuery, useEquipmentQuery, useBatchesQuery, useScheduleConflictsQuery, productionKeys, type ScheduleEntry, type ScheduleConflict } from "../hooks/queries";

const EQUIPMENT_STAGE_ORDER = ["brewhouse", "fermenter", "brite", "kegging", "canning"];
const STAGE_LABELS: Record<string, string> = {
  brewhouse:    "Brewhouse",
  fermenter:    "Fermenter",
  conditioning: "Brite / Conditioning",
  kegging:      "Kegging",
  canning:      "Canning",
  cold_storage: "Cold Storage",
};
// Map stage key → equipment.type so the dropdown shows only relevant gear
const STAGE_TO_EQ_TYPE: Record<string, string> = {
  brewhouse:    "brewhouse",
  fermenter:    "fermenter",
  conditioning: "brite",
  kegging:      "kegging",
  canning:      "canning",
  cold_storage: "cold_storage",
};
const STAGE_OPTIONS = ["brewhouse", "fermenter", "conditioning", "kegging", "canning", "cold_storage"] as const;

// Left-border accent color per equipment type for the group header rows
const TYPE_ACCENT: Record<string, string> = {
  brewhouse:    "#f59e0b", // amber
  fermenter:    "#3b82f6", // blue
  brite:        "#8b5cf6", // purple
  kegging:      "#10b981", // emerald
  canning:      "#06b6d4", // cyan
  cold_storage: "#6b7280", // gray
};

const BATCH_PALETTE = [
  "#f59e0b", "#3b82f6", "#10b981", "#8b5cf6",
  "#f43f5e", "#06b6d4", "#f97316", "#14b8a6",
  "#a855f7", "#84cc16", "#ec4899", "#6366f1",
];

const RANGE_OPTIONS = [
  { label: "2W", days: 14 },
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
  { label: "6M", days: 180 },
];

const ROW_H = 44;
const LABEL_W = 180;
const DAY_PX_BASE: Record<number, number> = { 14: 48, 30: 28, 90: 12, 180: 7 };

function blank() {
  return { batch_id: "", equipment_id: "", stage: "fermenting", planned_start: "", planned_end: "", notes: "" };
}

export default function GanttTab() {
  const qc = useQueryClient();
  const { data: equipment = [] } = useEquipmentQuery();
  const { data: batches = [] } = useBatchesQuery();
  const { data: entries = [] } = useBatchScheduleQuery();
  const { data: conflicts = [] } = useScheduleConflictsQuery();
  const [rangeIdx, setRangeIdx] = useState(2);
  const [viewStart, setViewStart] = useState(() => subDays(startOfToday(), 3));
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<ScheduleEntry | null>(null);
  const [form, setForm] = useState(blank());
  const [formActualStart, setFormActualStart] = useState("");
  const [formActualEnd, setFormActualEnd] = useState("");
  const [saving, setSaving] = useState(false);
  const [dismissedConflicts, setDismissedConflicts] = useState<Set<string>>(new Set());
  const [resolvingConflict, setResolvingConflict] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

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

  function entryBar(entry: ScheduleEntry, eqId: string) {
    if (entry.equipment_id !== eqId) return null;
    const isConflicted = conflictedEntryIds.has(entry.id);
    const color = entry.batch_id ? (batchColors[entry.batch_id] ?? "#6b7280") : "#6b7280";
    const label = entry.brew_batches
      ? `#${entry.brew_batches.batch_number} · ${entry.brew_batches.beer_name}`
      : "?";
    const today = startOfToday();

    const pStart = parseISO(entry.planned_start);
    const pEnd   = parseISO(entry.planned_end);
    const aStart = entry.actual_start ? parseISO(entry.actual_start) : null;
    const aEnd   = entry.actual_end   ? parseISO(entry.actual_end)   : null;

    // Unified bar: always spans barStart→barEnd as one visual element.
    // "Split point" separates the solid (actual/elapsed) left from the dashed (planned/remaining) right.
    const barStart    = aStart ?? pStart;
    const barEnd      = pEnd;
    const splitPoint  = aEnd ?? (aStart ? today : null); // where solid ends

    const barOffset = differenceInDays(barStart, viewStart);
    const barWidth  = Math.max(differenceInDays(barEnd, barStart), 1);
    if (barOffset > totalDays || barOffset + barWidth < 0) return null;

    const barLeft  = barOffset * dayPx;
    const barPx    = barWidth * dayPx;

    // Solid portion width (0 if fully planned, full bar if fully actual and done)
    const solidDays = splitPoint
      ? Math.min(Math.max(differenceInDays(splitPoint, barStart), 0), barWidth)
      : 0;
    const solidPct  = barWidth > 0 ? (solidDays / barWidth) * 100 : 0;
    const hasSolid  = solidDays > 0;

    const tooltipParts = [label];
    if (aStart && aEnd) tooltipParts.push(`Actual: ${format(aStart, "MMM d")} – ${format(aEnd, "MMM d")}`);
    else if (aStart)    tooltipParts.push(`Started: ${format(aStart, "MMM d")} (in progress)`);
    tooltipParts.push(`Planned: ${format(pStart, "MMM d")} – ${format(pEnd, "MMM d")}`);
    if (entry.notes) tooltipParts.push(entry.notes);

    return (
      <div
        key={entry.id}
        title={tooltipParts.join("\n")}
        onClick={() => openEdit(entry)}
        className="absolute top-1.5 bottom-1.5 cursor-pointer overflow-hidden select-none flex items-center"
        style={{ left: Math.max(barLeft, 0), width: Math.max(barPx, 6), borderRadius: 4, border: isConflicted ? `2px solid #ef4444` : `1.5px solid ${color}`, boxShadow: isConflicted ? "0 0 0 2px #ef444460" : undefined }}
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
        {barPx > 32 && (
          <span
            className="relative z-10 px-2 text-xs font-medium text-white truncate w-full"
            style={{ textShadow: "0 1px 2px rgba(0,0,0,0.8)" }}
          >
            {label}
          </span>
        )}
      </div>
    );
  }

  function openAdd() {
    setEditing(null);
    setForm(blank());
    setFormActualStart("");
    setFormActualEnd("");
    setShowModal(true);
  }

  function openEdit(entry: ScheduleEntry) {
    setEditing(entry);
    setForm({
      batch_id: entry.batch_id,
      equipment_id: entry.equipment_id ?? "",
      stage: entry.stage,
      planned_start: entry.planned_start.slice(0, 10),
      planned_end: entry.planned_end.slice(0, 10),
      notes: entry.notes ?? "",
    });
    setFormActualStart(entry.actual_start?.slice(0, 10) ?? "");
    setFormActualEnd(entry.actual_end?.slice(0, 10) ?? "");
    setShowModal(true);
  }

  async function save() {
    setSaving(true);
    const payload = {
      batch_id: form.batch_id,
      equipment_id: form.equipment_id || null,
      stage: form.stage,
      planned_start: form.planned_start ? new Date(form.planned_start).toISOString() : null,
      planned_end: form.planned_end ? new Date(form.planned_end).toISOString() : null,
      actual_start: formActualStart ? new Date(formActualStart).toISOString() : null,
      actual_end: formActualEnd ? new Date(formActualEnd).toISOString() : null,
      notes: form.notes || null,
    };
    const url = editing ? `/api/production/batch-schedule/${editing.id}` : "/api/production/batch-schedule";
    const method = editing ? "PATCH" : "POST";
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (res.ok) { await reloadSchedule(); setShowModal(false); }
    setSaving(false);
  }

  async function remove() {
    if (!editing) return;
    await fetch(`/api/production/batch-schedule/${editing.id}`, { method: "DELETE" });
    await reloadSchedule();
    setShowModal(false);
  }

  // Build header day labels (only show every N days depending on range)
  const labelEvery = rangeDays <= 14 ? 1 : rangeDays <= 30 ? 3 : rangeDays <= 90 ? 7 : 14;
  const dayLabels: { day: number; date: Date }[] = [];
  for (let d = 0; d < totalDays; d++) {
    if (d % labelEvery === 0) dayLabels.push({ day: d, date: addDays(viewStart, d) });
  }

  const todayOffset = differenceInDays(startOfToday(), viewStart);

  const f = (k: keyof typeof form, v: string) => setForm(prev => ({ ...prev, [k]: v }));

  return (
    <div>
      {/* Mobile placeholder */}
      <div className="md:hidden flex flex-col items-center justify-center py-16 px-6 text-center">
        <p className="text-zinc-400 font-medium mb-1">Timeline view is desktop-only</p>
        <p className="text-sm text-zinc-600">Open this page on a larger screen to view and manage the equipment schedule Gantt chart.</p>
      </div>

      <div className="hidden md:block">
      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="flex gap-1">
          {RANGE_OPTIONS.map((o, i) => (
            <button
              key={o.label}
              onClick={() => setRangeIdx(i)}
              className={`px-3 py-1 text-xs rounded font-medium ${rangeIdx === i ? "bg-amber-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          <button onClick={() => setViewStart(d => subDays(d, Math.floor(rangeDays / 3)))} className="px-2 py-1 text-xs bg-zinc-800 rounded text-zinc-400 hover:text-zinc-200">‹</button>
          <button onClick={() => setViewStart(subDays(startOfToday(), 3))} className="px-3 py-1 text-xs bg-zinc-800 rounded text-zinc-400 hover:text-zinc-200">Today</button>
          <button onClick={() => setViewStart(d => addDays(d, Math.floor(rangeDays / 3)))} className="px-2 py-1 text-xs bg-zinc-800 rounded text-zinc-400 hover:text-zinc-200">›</button>
        </div>
        <span className="text-xs text-zinc-500">{format(viewStart, "MMM d")} – {format(viewEnd, "MMM d, yyyy")}</span>
        <button onClick={openAdd} className="ml-auto px-3 py-1 text-xs bg-amber-600 hover:bg-amber-500 text-white rounded font-medium">+ Schedule Entry</button>
      </div>

      {/* Conflict Banner */}
      {conflicts.filter(c => !dismissedConflicts.has(c.id)).length > 0 && (
        <div className="mb-4 rounded-lg border border-red-700/60 bg-red-950/40 px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold text-red-400">
              ⚠ {conflicts.filter(c => !dismissedConflicts.has(c.id)).length} Schedule Conflict{conflicts.filter(c => !dismissedConflicts.has(c.id)).length > 1 ? "s" : ""} Detected
            </span>
          </div>
          <div className="space-y-2">
            {conflicts.filter(c => !dismissedConflicts.has(c.id)).map(conflict => (
              <div key={conflict.id} className="flex items-start justify-between gap-3 text-xs text-zinc-300 bg-red-900/20 rounded px-3 py-2">
                <div>
                  <span className="font-medium text-red-300">
                    {conflict.equipment.name ?? "Unknown equipment"}:
                  </span>{" "}
                  <span className="font-medium">#{conflict.entry_a.batch_number} {conflict.entry_a.beer_name}</span>
                  {" "}overlaps{" "}
                  <span className="font-medium">#{conflict.entry_b.batch_number} {conflict.entry_b.beer_name}</span>
                  {conflict.suggested_resolution && (
                    <span className="ml-1 text-zinc-400">
                      · Suggest: move #{conflict.entry_b.batch_number} to <span className="text-zinc-200">{conflict.suggested_resolution.equipment_name}</span>
                    </span>
                  )}
                </div>
                <div className="flex gap-2 flex-none">
                  {conflict.suggested_resolution && (
                    <button
                      onClick={() => applyConflictFix(conflict)}
                      disabled={resolvingConflict === conflict.id}
                      className="px-2 py-0.5 text-xs bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded"
                    >
                      {resolvingConflict === conflict.id ? "…" : "Apply Fix"}
                    </button>
                  )}
                  <button
                    onClick={() => setDismissedConflicts(prev => { const s = new Set(prev); s.add(conflict.id); return s; })}
                    className="px-2 py-0.5 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded"
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
      <div className="border border-zinc-700 rounded-lg overflow-auto bg-zinc-900" ref={containerRef}>
        {/* Header */}
        <div className="flex sticky top-0 z-10 bg-zinc-900 border-b border-zinc-700">
          <div className="flex-none bg-zinc-900 border-r border-zinc-700 text-xs text-zinc-500 font-medium flex items-end px-3 pb-2" style={{ width: LABEL_W }}>Equipment</div>
          <div className="relative flex-none" style={{ width: totalDays * dayPx, height: 40 }}>
            {dayLabels.map(({ day, date }) => (
              <div key={day} className="absolute bottom-2 text-xs text-zinc-500" style={{ left: day * dayPx + 2 }}>
                {format(date, rangeDays <= 30 ? "MMM d" : "MMM d")}
              </div>
            ))}
            {/* Today marker header */}
            {todayOffset >= 0 && todayOffset <= totalDays && (
              <div className="absolute top-0 bottom-0 w-px bg-amber-500/60" style={{ left: todayOffset * dayPx }} />
            )}
          </div>
        </div>

        {/* Rows — grouped by equipment type with colored section headers */}
        {rows.length === 0 ? (
          <div className="px-4 py-8 text-sm text-zinc-500 text-center">No schedulable equipment found. Add equipment in the Floorplan tab.</div>
        ) : EQUIPMENT_STAGE_ORDER.flatMap((type) => {
          const eqs = equipmentByType[type] ?? [];
          if (!eqs.length) return [];
          const accent = TYPE_ACCENT[type] ?? "#6b7280";
          const label  = STAGE_LABELS[type === "brite" ? "conditioning" : type] ?? type;
          return [
            /* Group header row */
            <div key={`hdr-${type}`} className="flex border-b border-zinc-800/80 sticky top-[40px] z-10" style={{ borderLeft: `3px solid ${accent}` }}>
              <div
                className="flex-none border-r border-zinc-700 px-3 flex items-center"
                style={{ width: LABEL_W - 3, height: 24, background: "#18181b" }}
              >
                <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: accent }}>{label}</span>
              </div>
              <div className="flex-none" style={{ width: totalDays * dayPx, height: 24, background: `${accent}08` }} />
            </div>,
            /* Equipment rows */
            ...eqs.map((eq) => (
              <div key={eq.id} className="flex border-b border-zinc-800 last:border-0">
                <div className="flex-none border-r border-zinc-700 px-3 py-1.5 flex items-center" style={{ width: LABEL_W, height: ROW_H }}>
                  <span className="text-xs text-zinc-300 truncate">{eq.name}</span>
                </div>
                <div className="relative flex-none bg-zinc-900/50" style={{ width: totalDays * dayPx, height: ROW_H }}>
                  {dayLabels.map(({ day }) => (
                    <div key={day} className="absolute top-0 bottom-0 w-px bg-zinc-800" style={{ left: day * dayPx }} />
                  ))}
                  {todayOffset >= 0 && todayOffset <= totalDays && (
                    <div className="absolute top-0 bottom-0 w-px bg-amber-500/40" style={{ left: todayOffset * dayPx }} />
                  )}
                  {entries.map(e => entryBar(e, eq.id))}
                </div>
              </div>
            )),
          ];
        })}
      </div>

      {/* Legend */}
      <div className="mt-3 flex flex-wrap gap-4 items-center">
        <div className="flex items-center gap-1.5 text-xs text-zinc-500">
          <div className="w-8 h-3 rounded-sm flex-none border border-dashed border-zinc-400 bg-zinc-700/30" />
          Planned
        </div>
        <div className="flex items-center gap-1.5 text-xs text-zinc-500">
          <div className="w-8 h-3 rounded-sm flex-none bg-zinc-400" />
          Actual
        </div>
        {batches.length > 0 && (
          <>
            <div className="w-px h-4 bg-zinc-700" />
            {batches.slice(0, 12).map((b, i) => (
              <div key={b.id} className="flex items-center gap-1.5 text-xs text-zinc-400">
                <div className="w-3 h-3 rounded-sm flex-none" style={{ background: BATCH_PALETTE[i % BATCH_PALETTE.length] }} />
                #{b.batch_number} {b.beer_name}
              </div>
            ))}
          </>
        )}
      </div>

      {/* Modal */}
      {showModal && (
        <Modal title={editing ? "Edit Schedule Entry" : "Add Schedule Entry"} onClose={() => setShowModal(false)}>
          <div className="space-y-4">
            <Field label="Batch">
              <select className="inp" value={form.batch_id} onChange={e => f("batch_id", e.target.value)}>
                <option value="">-- Select batch --</option>
                {batches.map(b => (
                  <option key={b.id} value={b.id}>#{b.batch_number} {b.beer_name}</option>
                ))}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Stage">
                <select className="inp" value={form.stage} onChange={e => { f("stage", e.target.value); f("equipment_id", ""); }}>
                  {STAGE_OPTIONS.map(s => <option key={s} value={s}>{STAGE_LABELS[s] ?? s}</option>)}
                </select>
              </Field>
              <Field label="Equipment">
                <select className="inp" value={form.equipment_id} onChange={e => f("equipment_id", e.target.value)}>
                  <option value="">— none —</option>
                  {(equipmentByType[STAGE_TO_EQ_TYPE[form.stage] ?? ""] ?? []).map(eq => (
                    <option key={eq.id} value={eq.id}>{eq.name}</option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Planned Start">
                <input type="date" className="inp" value={form.planned_start} onChange={e => f("planned_start", e.target.value)} />
              </Field>
              <Field label="Planned End">
                <input type="date" className="inp" value={form.planned_end} onChange={e => f("planned_end", e.target.value)} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Actual Start">
                <input type="date" className="inp" value={formActualStart} onChange={e => setFormActualStart(e.target.value)} />
              </Field>
              <Field label="Actual End">
                <input type="date" className="inp" value={formActualEnd} onChange={e => setFormActualEnd(e.target.value)} />
              </Field>
            </div>
            <Field label="Notes">
              <input type="text" className="inp" value={form.notes} onChange={e => f("notes", e.target.value)} placeholder="Optional" />
            </Field>
            <div className="flex gap-2">
              <button onClick={save} disabled={saving || !form.batch_id || !form.planned_start || !form.planned_end} className="flex-1 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-medium rounded">
                {saving ? "Saving…" : editing ? "Save Changes" : "Add Entry"}
              </button>
              {editing && (
                <button onClick={remove} className="px-4 py-2 bg-zinc-700 hover:bg-red-800 text-zinc-300 text-sm rounded">Delete</button>
              )}
            </div>
          </div>
        </Modal>
      )}
      </div>
    </div>
  );
}
