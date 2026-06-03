"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import {
  format, startOfDay, addDays, differenceInDays, parseISO,
  startOfToday, subDays,
} from "date-fns";
import { Equipment, BrewBatch } from "../types";
import { Modal, Field } from "./shared";

interface ScheduleEntry {
  id: string;
  batch_id: string;
  equipment_id: string | null;
  stage: string;
  planned_start: string;
  planned_end: string;
  actual_start: string | null;
  actual_end: string | null;
  notes: string | null;
  brew_batches: { id: string; beer_name: string; batch_number: number; volume_bbl: number; status: string } | null;
  equipment: { id: string; name: string; type: string } | null;
}

interface Props {
  equipment: Equipment[];
  batches: BrewBatch[];
}

const EQUIPMENT_STAGE_ORDER = ["brewhouse", "fermenter", "brite", "cold_storage", "kegging", "canning"];
const STAGE_LABELS: Record<string, string> = {
  brewhouse: "Brewhouse",
  fermenter: "Fermenter",
  brite: "Brite Tank",
  cold_storage: "Cold Storage",
  kegging: "Kegging",
  canning: "Canning",
  conditioning: "Conditioning",
};
const STAGE_OPTIONS = ["brewhouse", "fermenting", "conditioning", "kegging", "canning", "cold_storage"] as const;

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

const ROW_H = 36;
const LABEL_W = 180;
const DAY_PX_BASE: Record<number, number> = { 14: 48, 30: 28, 90: 12, 180: 7 };

function blank() {
  return { batch_id: "", equipment_id: "", stage: "fermenting", planned_start: "", planned_end: "", notes: "" };
}

export default function GanttTab({ equipment, batches }: Props) {
  const [entries, setEntries] = useState<ScheduleEntry[]>([]);
  const [rangeIdx, setRangeIdx] = useState(1);
  const [viewStart, setViewStart] = useState(() => subDays(startOfToday(), 3));
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<ScheduleEntry | null>(null);
  const [form, setForm] = useState(blank());
  const [saving, setSaving] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const rangeDays = RANGE_OPTIONS[rangeIdx].days;
  const dayPx = DAY_PX_BASE[rangeDays] ?? 12;
  const totalDays = rangeDays;
  const viewEnd = addDays(viewStart, totalDays);

  async function load() {
    const res = await fetch("/api/production/batch-schedule");
    if (res.ok) setEntries(await res.json());
  }

  useEffect(() => { load(); }, []);

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
    const start = parseISO(entry.planned_start);
    const end = parseISO(entry.planned_end);
    const offsetDays = differenceInDays(start, viewStart);
    const widthDays = Math.max(differenceInDays(end, start), 0.5);
    if (offsetDays > totalDays || offsetDays + widthDays < 0) return null;
    const left = offsetDays * dayPx;
    const width = widthDays * dayPx;
    const color = entry.batch_id ? (batchColors[entry.batch_id] ?? "#6b7280") : "#6b7280";
    const label = entry.brew_batches
      ? `#${entry.brew_batches.batch_number} ${entry.brew_batches.beer_name}`
      : "?";
    return (
      <div
        key={entry.id}
        title={`${label}\n${format(start, "MMM d")} – ${format(end, "MMM d")}\n${entry.notes ?? ""}`}
        onClick={() => openEdit(entry)}
        className="absolute top-1 bottom-1 rounded cursor-pointer flex items-center px-2 text-xs font-medium text-white overflow-hidden select-none"
        style={{ left, width: Math.max(width, 4), background: color, opacity: 0.9 }}
      >
        {width > 40 && <span className="truncate">{label}</span>}
      </div>
    );
  }

  function openAdd() {
    setEditing(null);
    setForm(blank());
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
      notes: form.notes || null,
    };
    const url = editing ? `/api/production/batch-schedule/${editing.id}` : "/api/production/batch-schedule";
    const method = editing ? "PATCH" : "POST";
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (res.ok) { await load(); setShowModal(false); }
    setSaving(false);
  }

  async function remove() {
    if (!editing) return;
    await fetch(`/api/production/batch-schedule/${editing.id}`, { method: "DELETE" });
    await load();
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
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-medium text-zinc-100">Timeline</h2>
          <p className="text-sm text-zinc-500 mt-0.5">Gantt view of equipment occupancy — plan and visualize batch scheduling across the brewery</p>
        </div>
      </div>

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

        {/* Rows */}
        {rows.length === 0 ? (
          <div className="px-4 py-8 text-sm text-zinc-500 text-center">No schedulable equipment found. Add equipment in the Floorplan tab.</div>
        ) : rows.map(({ eq, typeLabel, isFirst }) => (
          <div key={eq.id} className="flex border-b border-zinc-800 last:border-0">
            {/* Row label */}
            <div className={`flex-none border-r border-zinc-700 px-3 flex flex-col justify-center ${isFirst ? "pt-2" : ""}`} style={{ width: LABEL_W, height: ROW_H }}>
              {isFirst && <span className="text-xs text-zinc-500 font-semibold leading-none mb-0.5">{typeLabel}</span>}
              <span className="text-xs text-zinc-300 truncate">{eq.name}</span>
            </div>
            {/* Bar area */}
            <div className="relative flex-none bg-zinc-900/50" style={{ width: totalDays * dayPx, height: ROW_H }}>
              {/* Grid lines */}
              {dayLabels.map(({ day }) => (
                <div key={day} className="absolute top-0 bottom-0 w-px bg-zinc-800" style={{ left: day * dayPx }} />
              ))}
              {/* Today marker */}
              {todayOffset >= 0 && todayOffset <= totalDays && (
                <div className="absolute top-0 bottom-0 w-px bg-amber-500/40" style={{ left: todayOffset * dayPx }} />
              )}
              {/* Bars */}
              {entries.map(e => entryBar(e, eq.id))}
            </div>
          </div>
        ))}
      </div>

      {/* Legend */}
      {batches.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-3">
          {batches.slice(0, 12).map((b, i) => (
            <div key={b.id} className="flex items-center gap-1.5 text-xs text-zinc-400">
              <div className="w-3 h-3 rounded-sm flex-none" style={{ background: BATCH_PALETTE[i % BATCH_PALETTE.length] }} />
              #{b.batch_number} {b.beer_name}
            </div>
          ))}
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <Modal title={editing ? "Edit Schedule Entry" : "Add Schedule Entry"} onClose={() => setShowModal(false)}>
          <Field label="Batch">
            <select className="inp" value={form.batch_id} onChange={e => f("batch_id", e.target.value)}>
              <option value="">-- Select batch --</option>
              {batches.map(b => (
                <option key={b.id} value={b.id}>#{b.batch_number} {b.beer_name}</option>
              ))}
            </select>
          </Field>
          <Field label="Equipment (optional)">
            <select className="inp" value={form.equipment_id} onChange={e => f("equipment_id", e.target.value)}>
              <option value="">-- No specific equipment --</option>
              {EQUIPMENT_STAGE_ORDER.flatMap(type =>
                (equipmentByType[type] ?? []).map(eq => (
                  <option key={eq.id} value={eq.id}>{STAGE_LABELS[type]} — {eq.name}</option>
                ))
              )}
            </select>
          </Field>
          <Field label="Stage">
            <select className="inp" value={form.stage} onChange={e => f("stage", e.target.value)}>
              {STAGE_OPTIONS.map(s => <option key={s} value={s}>{STAGE_LABELS[s] ?? s}</option>)}
            </select>
          </Field>
          <Field label="Planned Start">
            <input type="date" className="inp" value={form.planned_start} onChange={e => f("planned_start", e.target.value)} />
          </Field>
          <Field label="Planned End">
            <input type="date" className="inp" value={form.planned_end} onChange={e => f("planned_end", e.target.value)} />
          </Field>
          <Field label="Notes">
            <input type="text" className="inp" value={form.notes} onChange={e => f("notes", e.target.value)} placeholder="Optional" />
          </Field>
          <div className="flex gap-2 mt-2">
            <button onClick={save} disabled={saving || !form.batch_id || !form.planned_start || !form.planned_end} className="flex-1 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-medium rounded">
              {saving ? "Saving…" : editing ? "Save Changes" : "Add Entry"}
            </button>
            {editing && (
              <button onClick={remove} className="px-4 py-2 bg-zinc-700 hover:bg-red-800 text-zinc-300 text-sm rounded">Delete</button>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
