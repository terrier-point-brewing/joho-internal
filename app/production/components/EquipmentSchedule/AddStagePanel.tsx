"use client";

import React, { useState } from "react";
import type { Equipment } from "../../types";
import { PLANNING_STAGES, STAGE_LABELS, STAGE_TO_EQ_TYPE } from "./constants";

export function AddStagePanel({
  batchId,
  equipment,
  plannedBranch,
  onSaved,
  onClose,
}: {
  batchId: string;
  equipment: Equipment[];
  plannedBranch?: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [stage, setStage]           = useState("fermenting");
  const [equipmentId, setEquipmentId] = useState("");
  const [start, setStart]           = useState("");
  const [end, setEnd]               = useState("");
  const [volBbl, setVolBbl]         = useState("");
  const [saving, setSaving]         = useState(false);

  const pool       = equipment.filter(eq => eq.type === STAGE_TO_EQ_TYPE[stage]);
  const isPackaging = stage === "kegging" || stage === "canning";

  async function save() {
    if (!start || !end) { alert("Start and end dates are required."); return; }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        batch_id:      batchId,
        equipment_id:  equipmentId || null,
        stage,
        planned_start: start + "T12:00:00",
        planned_end:   end   + "T12:00:00",
        ...(isPackaging && volBbl ? { volume_bbl: Number(volBbl) } : {}),
        ...(plannedBranch ? { planned_branch: plannedBranch } : {}),
      };
      const res = await fetch("/api/production/batch-schedule", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
      onSaved();
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-2 rounded border border-zinc-700 bg-zinc-900/60 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-400">
          Add Stage{plannedBranch ? ` — ${plannedBranch}` : ""}
        </span>
        <button type="button" onClick={onClose} className="text-xs text-zinc-600 hover:text-zinc-400">✕</button>
      </div>
      <div className={`grid gap-2 ${isPackaging ? "grid-cols-5" : "grid-cols-4"}`}>
        <div>
          <label className="block text-[10px] mb-0.5 text-zinc-500">Stage</label>
          <select className="inp text-xs w-full" value={stage}
            onChange={e => { setStage(e.target.value); setEquipmentId(""); }}>
            {PLANNING_STAGES.map(s => (
              <option key={s} value={s}>{STAGE_LABELS[s] ?? s}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[10px] mb-0.5 text-zinc-500">Equipment</label>
          <select className="inp text-xs w-full" value={equipmentId} onChange={e => setEquipmentId(e.target.value)}>
            <option value="">— none —</option>
            {pool.map(eq => (
              <option key={eq.id} value={eq.id}>{eq.name}{eq.capacity_bbl ? ` (${eq.capacity_bbl} BBL)` : ""}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[10px] mb-0.5 text-zinc-500">Start</label>
          <input type="date" className="inp text-xs w-full" value={start} onChange={e => setStart(e.target.value)} />
        </div>
        <div>
          <label className="block text-[10px] mb-0.5 text-zinc-500">End</label>
          <input type="date" className="inp text-xs w-full" value={end} onChange={e => setEnd(e.target.value)} />
        </div>
        {isPackaging && (
          <div>
            <label className="block text-[10px] mb-0.5 text-zinc-500">BBL</label>
            <input type="number" step="0.01" min="0" placeholder="e.g. 3.5" className="inp text-xs w-full"
              value={volBbl} onChange={e => setVolBbl(e.target.value)} />
          </div>
        )}
      </div>
      <div className="flex gap-2 pt-1">
        <button type="button" onClick={save} disabled={saving}
          className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded font-medium">
          {saving ? "Saving…" : "Add stage"}
        </button>
        <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-300">Cancel</button>
      </div>
    </div>
  );
}
