"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";
import { Recipe, Equipment } from "../../types";
import { fmtDateLong } from "@/lib/utils/formatting";
import { Field } from "../shared";
import { fetchJson } from "../../hooks/queries";
import type { SchedulerRecommendation } from "@/app/api/production/batch-scheduler/route";

// Editable version of a recommendation row
interface SchedulerRow {
  id: string; // local key
  recipe_id: string;
  style: string;
  stockout_date: string | null;
  demand_bbl: number;
  turns: number;
  volume_bbl: number;
  brew_date: string;
  notes: string;
  equipment_sequence: EditableSlot[];
  isManual: boolean;
}

interface EditableSlot {
  stage: "brewhouse" | "fermenter" | "brite";
  equipment_id: string;
  scheduled_start: string;
  scheduled_end: string;
}

const STAGE_LABELS: Record<string, string> = {
  brewhouse: "BH",
  fermenter: "FV",
  brite: "BT",
};

const STAGE_COLORS: Record<string, string> = {
  brewhouse: "bg-amber-900/50 text-amber-300 border-amber-700",
  fermenter: "bg-blue-900/50 text-blue-300 border-blue-700",
  brite: "bg-purple-900/50 text-purple-300 border-purple-700",
};

function toRow(rec: SchedulerRecommendation): SchedulerRow {
  return {
    id: `${rec.recipe_id}-${Date.now()}-${Math.random()}`,
    recipe_id: rec.recipe_id,
    style: rec.style,
    stockout_date: rec.stockout_date,
    demand_bbl: rec.demand_bbl,
    turns: rec.recommended_turns,
    volume_bbl: rec.recommended_volume_bbl,
    brew_date: rec.recommended_brew_date,
    notes: "",
    equipment_sequence: rec.equipment_sequence.map((s) => ({
      stage: s.stage,
      equipment_id: s.equipment_id,
      scheduled_start: s.scheduled_start,
      scheduled_end: s.scheduled_end,
    })),
    isManual: false,
  };
}

function SlotChips({ slots, tanks }: { slots: EditableSlot[]; tanks: Equipment[] }) {
  const tankById = new Map(tanks.map((t) => [t.id, t]));
  return (
    <div className="flex flex-wrap gap-1">
      {slots.map((s, i) => (
        <span key={i} className={`text-xs px-2 py-0.5 rounded border font-mono ${STAGE_COLORS[s.stage] ?? ""}`}>
          {STAGE_LABELS[s.stage]} {tankById.get(s.equipment_id)?.name ?? "?"}
          <span className="opacity-60 font-normal"> {format(parseISO(s.scheduled_start), "MMM d")}–{format(parseISO(s.scheduled_end), "MMM d")}</span>
        </span>
      ))}
    </div>
  );
}

function ExpandedEditor({
  row,
  recipes,
  tanks,
  onChange,
}: {
  row: SchedulerRow;
  recipes: Recipe[];
  tanks: Equipment[];
  onChange: (updated: SchedulerRow) => void;
}) {
  const brewhouses = tanks.filter((t) => t.type === "brewhouse");
  const fermenters = tanks.filter((t) => t.type === "fermenter");
  const brites = tanks.filter((t) => t.type === "brite");
  const stageEquipment = { brewhouse: brewhouses, fermenter: fermenters, brite: brites };

  function setField<K extends keyof SchedulerRow>(k: K, v: SchedulerRow[K]) {
    const updated = { ...row, [k]: v };
    // Recalculate volume_bbl when turns change
    if (k === "turns") {
      const recipe = recipes.find((r) => r.id === row.recipe_id);
      if (recipe?.expected_yield_bbl) {
        updated.volume_bbl = (v as number) * recipe.expected_yield_bbl;
      }
    }
    onChange(updated);
  }

  function setSlotField(idx: number, k: keyof EditableSlot, v: string) {
    const seq = row.equipment_sequence.map((s, i) => i === idx ? { ...s, [k]: v } : s);
    onChange({ ...row, equipment_sequence: seq });
  }

  return (
    <div className="px-4 pb-4 pt-2 space-y-4 border-t border-zinc-800/60">
      <div className="grid grid-cols-4 gap-3">
        {row.isManual && (
          <Field label="Recipe" required>
            <select className="inp" value={row.recipe_id}
              onChange={(e) => {
                const r = recipes.find((x) => x.id === e.target.value);
                onChange({ ...row, recipe_id: e.target.value, style: r?.beer_name ?? row.style });
              }}>
              <option value="">— select —</option>
              {recipes.map((r) => <option key={r.id} value={r.id}>{r.beer_name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Turns (max 4)" required>
          <input type="number" step="1" min="1" max="4" className="inp" value={row.turns}
            onChange={(e) => setField("turns", Math.min(4, Math.max(1, parseInt(e.target.value) || 1)))} />
        </Field>
        <Field label="Volume (BBL)">
          <div className="inp text-zinc-400">{row.volume_bbl.toFixed(2)}</div>
        </Field>
        <Field label="Brew Date" required>
          <input type="date" className="inp" value={row.brew_date}
            onChange={(e) => setField("brew_date", e.target.value)} />
        </Field>
        <Field label="Notes">
          <input className="inp" value={row.notes}
            onChange={(e) => setField("notes", e.target.value)} />
        </Field>
      </div>

      <div>
        <p className="text-xs text-zinc-500 font-medium mb-2">Equipment Sequence</p>
        <div className="space-y-2">
          {row.equipment_sequence.map((slot, idx) => (
            <div key={idx} className="grid grid-cols-3 gap-2">
              <Field label={`${STAGE_LABELS[slot.stage]} Equipment`} required>
                <select className="inp" value={slot.equipment_id}
                  onChange={(e) => setSlotField(idx, "equipment_id", e.target.value)}>
                  <option value="">— select —</option>
                  {(stageEquipment[slot.stage] ?? []).map((eq) => (
                    <option key={eq.id} value={eq.id}>{eq.name}{eq.capacity_bbl ? ` (${eq.capacity_bbl} BBL)` : ""}</option>
                  ))}
                </select>
              </Field>
              <Field label="Start Date" required>
                <input type="date" className="inp" value={slot.scheduled_start}
                  onChange={(e) => setSlotField(idx, "scheduled_start", e.target.value)} />
              </Field>
              <Field label="End Date" required>
                <input type="date" className="inp" value={slot.scheduled_end}
                  onChange={(e) => setSlotField(idx, "scheduled_end", e.target.value)} />
              </Field>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function BatchSchedulerTab({
  recipes, tanks, onBatchCommitted,
}: {
  recipes: Recipe[];
  tanks: Equipment[];
  onBatchCommitted?: () => void;
}) {
  const { data: recs = [], isLoading: loading, error, refetch } = useQuery({
    queryKey: ["production", "batch-scheduler"],
    queryFn: () => fetchJson<SchedulerRecommendation[]>("/api/production/batch-scheduler"),
  });
  const [rows, setRows] = useState<SchedulerRow[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState(false);

  // Seed the editable grid whenever fresh recommendations arrive.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- editable local copy derived from fetched data
  useEffect(() => { setRows(recs.map(toRow)); }, [recs]);

  const load = () => refetch();
  const err = error instanceof Error ? error.message : null;

  function toggleExpand(id: string) {
    setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  function updateRow(updated: SchedulerRow) {
    setRows((prev) => prev.map((r) => r.id === updated.id ? updated : r));
  }

  function removeRow(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id));
    setExpanded((s) => { const n = new Set(s); n.delete(id); return n; });
  }

  function addManualRow() {
    const today = new Date().toISOString().slice(0, 10);
    const newRow: SchedulerRow = {
      id: `manual-${Date.now()}`,
      recipe_id: "",
      style: "New Batch",
      stockout_date: null,
      demand_bbl: 0,
      turns: 1,
      volume_bbl: 0,
      brew_date: today,
      notes: "",
      equipment_sequence: [],
      isManual: true,
    };
    setRows((prev) => [...prev, newRow]);
    setExpanded((s) => new Set([...s, newRow.id]));
  }

  async function commitAll() {
    if (rows.length === 0) return;
    // Validate
    for (const row of rows) {
      if (!row.recipe_id) { alert(`Recipe is required for all batches.`); return; }
      if (!row.brew_date) { alert(`Brew date is required for ${row.style}.`); return; }
      if (row.equipment_sequence.some((s) => !s.equipment_id)) {
        alert(`Equipment must be selected for all stages in ${row.style}.`); return;
      }
    }

    setCommitting(true);
    try {
      for (const row of rows) {
        const recipe = recipes.find((r) => r.id === row.recipe_id);
        // 1. Create brew batch
        const batchRes = await fetch("/api/production/batches", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recipe_id: row.recipe_id,
            beer_name: recipe?.beer_name ?? row.style,
            planned_brew_date: row.brew_date,
            volume_bbl: row.volume_bbl,
            turns: row.turns,
            notes: row.notes || null,
          }),
        });
        if (!batchRes.ok) throw new Error((await batchRes.json()).error ?? `Failed to create batch for ${row.style}`);
        const batch = await batchRes.json();

        // 2. Create batch_schedule_entries for each equipment stage
        for (const slot of row.equipment_sequence) {
          const entryRes = await fetch("/api/production/batch-schedule", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              batch_id: batch.id,
              equipment_id: slot.equipment_id,
              stage: slot.stage === "brite" ? "conditioning" : slot.stage,
              planned_start: `${slot.scheduled_start}T00:00:00.000Z`,
              planned_end: `${slot.scheduled_end}T00:00:00.000Z`,
            }),
          });
          if (!entryRes.ok) {
            console.error("Schedule entry failed", await entryRes.json());
          }
        }
      }

      setCommitted(true);
      setRows([]);
      onBatchCommitted?.();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Commit failed");
    } finally {
      setCommitting(false);
    }
  }

  if (loading) return <p className="text-zinc-600 text-sm py-10 text-center">Loading recommendations…</p>;
  if (err) return <p className="text-sm text-red-400 py-6">{err}</p>;

  if (committed) return (
    <div className="py-16 text-center space-y-3">
      <p className="text-green-400 font-medium">✓ Batches committed successfully</p>
      <p className="text-zinc-500 text-sm">They now appear in Brewing → Batch Log and the Gantt timeline.</p>
      <button onClick={() => { setCommitted(false); load(); }}
        className="px-3 py-1.5 border border-zinc-700 hover:border-zinc-500 text-zinc-300 text-sm rounded transition-colors">
        Load New Recommendations
      </button>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex justify-between items-center">
        <p className="text-sm text-zinc-500">
          Recommended batches based on demand calendar stockouts. Review, edit, then commit to create batches and schedule equipment.
        </p>
        <div className="flex gap-2">
          <button onClick={load} className="px-3 py-1.5 border border-zinc-700 hover:border-zinc-500 text-zinc-300 text-sm rounded transition-colors">
            Refresh
          </button>
          <button onClick={addManualRow} className="px-3 py-1.5 border border-zinc-700 hover:border-zinc-500 text-zinc-300 text-sm rounded transition-colors">
            + Add Batch
          </button>
        </div>
      </div>

      {rows.length === 0 && recs.length === 0 && (
        <div className="py-16 text-center space-y-2">
          <p className="text-zinc-600 text-sm">No batches need scheduling right now.</p>
          <p className="text-xs text-zinc-700">All styles are within safe stock levels, or no demand data exists. Use &quot;+ Add Batch&quot; to schedule manually.</p>
        </div>
      )}

      {rows.length === 0 && recs.length > 0 && (
        <p className="text-zinc-600 text-sm py-4 text-center">All recommendations removed. Use &quot;+ Add Batch&quot; to add one back.</p>
      )}

      {/* Batch rows */}
      {rows.length > 0 && (
        <div className="rounded-lg border border-zinc-800 overflow-hidden">
          {rows.map((row, i) => (
            <div key={row.id} className={`${i > 0 ? "border-t border-zinc-800/60" : ""} ${i % 2 !== 0 ? "bg-zinc-900/30" : ""}`}>
              <div className="flex items-center gap-3 px-4 py-3">
                <button onClick={() => toggleExpand(row.id)} className="text-zinc-600 hover:text-zinc-400 text-xs shrink-0 w-4">
                  {expanded.has(row.id) ? "▼" : "▶"}
                </button>

                {/* Status indicator */}
                {row.stockout_date && (
                  <span className="text-xs text-red-400/80 shrink-0">
                    Stockout {fmtDateLong(row.stockout_date)}
                  </span>
                )}
                {row.isManual && <span className="text-xs text-zinc-600 shrink-0">Manual</span>}

                <span className="font-medium text-zinc-100 min-w-[140px]">{row.style}</span>

                <div className="flex items-center gap-2 text-xs text-zinc-500 shrink-0">
                  <span>{row.turns}T</span>
                  <span>·</span>
                  <span>{row.volume_bbl.toFixed(1)} BBL</span>
                  <span>·</span>
                  <span>Brew {row.brew_date ? fmtDateLong(row.brew_date) : "—"}</span>
                </div>

                <div className="flex-1 min-w-0">
                  <SlotChips slots={row.equipment_sequence} tanks={tanks} />
                </div>

                <button onClick={() => removeRow(row.id)}
                  className="text-xs text-red-400/60 hover:text-red-400 shrink-0">
                  Remove
                </button>
              </div>

              {expanded.has(row.id) && (
                <ExpandedEditor row={row} recipes={recipes} tanks={tanks} onChange={updateRow} />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Commit bar */}
      {rows.length > 0 && (
        <div className="flex justify-between items-center p-4 bg-zinc-900/50 border border-zinc-800 rounded-lg">
          <p className="text-sm text-zinc-400">
            {rows.length} batch{rows.length !== 1 ? "es" : ""} ready to commit. Review equipment dates, then commit to create batches and schedule equipment.
          </p>
          <button onClick={commitAll} disabled={committing}
            className="px-5 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-medium rounded transition-colors">
            {committing ? "Committing…" : "Commit All Batches"}
          </button>
        </div>
      )}
    </div>
  );
}
