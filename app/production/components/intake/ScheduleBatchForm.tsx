"use client";

import { useEffect, useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { parseISO, addDays, differenceInDays } from "date-fns";
import { Recipe, Equipment, ContractBrewingRequest, AllocationChannel, leadTimeDays } from "../../types";
import { fmtDateLong } from "@/lib/utils/formatting";
import { Field } from "../shared";
import { fetchJson, useBatchScheduleQuery, type ScheduleEntry } from "../../hooks/queries";
import type { SchedulerRecommendation, SchedulerResponse } from "@/app/api/production/batch-scheduler/route";
import Banner from "@/app/components/ui/Banner";
import { CATEGORY_BADGE_CLASS as CC } from "../../lib/categoryColors";
import { batchFillBbl } from "@/lib/production/batchVolume";

interface PendingAllocation {
  id: string; // local key only
  channel: AllocationChannel;
  percentage: string; // string for input binding
  partner_id: string;
  contract_request_id: string;
  notes: string;
}

interface EditableSlot {
  stage: "brewhouse" | "fermenter" | "brite";
  equipment_id: string;
  scheduled_start: string;
  scheduled_end: string;
}

interface SchedulerRow {
  id: string;
  recipe_id: string;
  style: string;
  stockout_date: string | null;
  demand_bbl: number;
  turns: number;
  volume_bbl: number;
  brew_date: string;
  expected_delivery_date: string;
  notes: string;
  equipment_sequence: EditableSlot[];
  allocations: PendingAllocation[];
  isManual: boolean;
  /** Why the server could not plan this batch. The brewer can still plan it by hand. */
  blocked_reason: string | null;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** What a commitment still needs from a NEW batch: booked minus what already sits on one. */
function uncoveredBbl(c: ContractBrewingRequest): number {
  return Math.max(0, Number(c.volume_bbl) - Number(c.committed_allocated_bbl ?? 0));
}

/** Open commitments for a recipe that no batch fully covers yet. */
function commitmentsNeedingBatch(commitments: ContractBrewingRequest[], recipeId: string): ContractBrewingRequest[] {
  return commitments.filter((c) => c.recipe_id === recipeId && c.status === "open" && uncoveredBbl(c) >= 0.1);
}

/** Build commitment allocations and always append a taproom row for the remainder.
 *  Each commitment takes only its UNCOVERED volume, capped at what the batch has
 *  left, so a deal already on a batch is never booked twice. */
function buildAutoAllocations(relevant: ContractBrewingRequest[], volumeBbl: number): PendingAllocation[] {
  let leftPct = 100;
  const commitmentAllocs = relevant.flatMap((c) => {
    const want = volumeBbl > 0 ? Math.round((uncoveredBbl(c) / volumeBbl) * 100 * 10) / 10 : 0;
    const pct = Math.min(want, leftPct);
    if (pct <= 0) return [];
    leftPct = Math.round((leftPct - pct) * 10) / 10;
    return [newAlloc({ channel: c.channel, percentage: String(pct), partner_id: c.partner_id ?? "", contract_request_id: c.id })];
  });
  const usedPct = commitmentAllocs.reduce((s, a) => s + (parseFloat(a.percentage) || 0), 0);
  const taproomPct = Math.max(0, Math.round((100 - usedPct) * 10) / 10);
  return [...commitmentAllocs, newAlloc({ channel: "taproom", percentage: String(taproomPct) })];
}

const STAGE_LABELS: Record<string, string> = { brewhouse: "Brewhouse", fermenter: "Fermenter", brite: "Brite Tank" };

function calcDeliveryDate(brewDate: string, recipe: Recipe | undefined): string {
  if (!brewDate || !recipe) return "";
  const lead = leadTimeDays(recipe);
  if (lead <= 0) return "";
  return addDays(parseISO(brewDate), lead).toISOString().slice(0, 10);
}
const STAGE_COLORS: Record<string, string> = {
  brewhouse: "bg-accent-muted/50 text-accent-soft border-accent-border",
  fermenter: "bg-info-surface/50 text-info border-info-border",
  brite: CC.purple,
};

function urgencyBadge(row: SchedulerRow) {
  if (row.isManual) return <span className="text-xs px-2 py-0.5 rounded border border-line-strong text-muted">Manual</span>;
  if (!row.stockout_date) return null;
  const days = differenceInDays(parseISO(row.stockout_date), new Date());
  if (days <= 14) return <span className="text-xs px-2 py-0.5 rounded border border-danger-border bg-danger-surface/40 text-danger">Stockout {fmtDateLong(row.stockout_date)}</span>;
  return <span className="text-xs px-2 py-0.5 rounded border border-accent-border bg-accent-muted/40 text-accent-soft">Stockout {fmtDateLong(row.stockout_date)}</span>;
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && aEnd > bStart;
}

function slotConflicted(slot: EditableSlot, entries: ScheduleEntry[]): boolean {
  if (!slot.equipment_id || !slot.scheduled_start || !slot.scheduled_end) return false;
  try {
    const s = parseISO(slot.scheduled_start), e = parseISO(slot.scheduled_end);
    return entries.some((entry) =>
      entry.equipment_id === slot.equipment_id &&
      overlaps(s, e, parseISO(entry.planned_start), parseISO(entry.planned_end))
    );
  } catch { return false; }
}

function toRow(rec: SchedulerRecommendation): SchedulerRow {
  return {
    id: `rec-${rec.recipe_id}`,
    recipe_id: rec.recipe_id,
    style: rec.style,
    stockout_date: rec.stockout_date ?? null,
    demand_bbl: rec.demand_bbl,
    turns: rec.recommended_turns,
    volume_bbl: rec.recommended_volume_bbl,
    brew_date: rec.recommended_brew_date,
    expected_delivery_date: "",
    notes: "",
    equipment_sequence: rec.equipment_sequence
      .filter((s): s is typeof s & { stage: "brewhouse" | "fermenter" | "brite" } =>
        s.stage === "brewhouse" || s.stage === "fermenter" || s.stage === "brite"
      )
      .map((s) => ({
        stage: s.stage,
        equipment_id: s.equipment_id,
        scheduled_start: s.scheduled_start,
        scheduled_end: s.scheduled_end,
      })),
    allocations: [],
    isManual: false,
    blocked_reason: rec.blocked_reason,
  };
}

// ─── Equipment schedule section ───────────────────────────────────────────────

function EquipmentSection({
  row,
  recipes,
  tanks,
  scheduleEntries,
  onChange,
}: {
  row: SchedulerRow;
  recipes: Recipe[];
  tanks: Equipment[];
  scheduleEntries: ScheduleEntry[];
  onChange: (updated: SchedulerRow) => void;
}) {
  const brewhouses = tanks.filter((t) => t.type === "brewhouse");
  const fermenters = tanks.filter((t) => t.type === "fermenter");
  const brites = tanks.filter((t) => t.type === "brite");
  const stageEquipment: Record<string, Equipment[]> = { brewhouse: brewhouses, fermenter: fermenters, brite: brites };

  const stages: EditableSlot["stage"][] = ["brewhouse", "fermenter", "brite"];
  const recipe = recipes.find((r) => r.id === row.recipe_id);
  const stageDays: Record<string, number> = {
    brewhouse: recipe?.days_brewhouse ?? 1,
    fermenter: recipe?.days_fermenter ?? 14,
    brite: recipe?.days_brite ?? 7,
  };

  // Multiple tanks per stage: equipment_sequence can have multiple entries per stage (parallel).
  // All parallel tanks in a stage share the same start/end dates.
  function slotsForStage(stage: EditableSlot["stage"]) {
    return row.equipment_sequence.filter((s) => s.stage === stage);
  }

  function updateSlotAt(stage: EditableSlot["stage"], idx: number, patch: Partial<EditableSlot>) {
    const stageSlots = slotsForStage(stage);
    const updated = { ...stageSlots[idx], ...patch };
    // When start/end changes, propagate to later stages (using first slot of each stage as anchor)
    const allOther = row.equipment_sequence.filter((s) => s.stage !== stage);
    const newStageSlots = stageSlots.map((s, i) => i === idx ? updated : { ...s, scheduled_start: updated.scheduled_start, scheduled_end: updated.scheduled_end });
    let newSeq = [...allOther, ...newStageSlots].sort((a, b) => stages.indexOf(a.stage) - stages.indexOf(b.stage));

    // Propagate dates forward from this stage
    const stageIdx = stages.indexOf(stage);
    let cursor = updated.scheduled_end ? parseISO(updated.scheduled_end) : null;
    if (cursor) {
      newSeq = newSeq.map((slot) => {
        if (stages.indexOf(slot.stage) <= stageIdx) return slot;
        const prevStageEnd = cursor!.toISOString().slice(0, 10);
        const end = addDays(cursor!, stageDays[slot.stage]).toISOString().slice(0, 10);
        cursor = parseISO(end);
        return { ...slot, scheduled_start: prevStageEnd, scheduled_end: end };
      });
    }
    onChange({ ...row, equipment_sequence: newSeq });
  }

  function addTankForStage(stage: EditableSlot["stage"]) {
    // New tank inherits dates from existing first slot for that stage, if any
    const existing = slotsForStage(stage)[0];
    const newSlot: EditableSlot = {
      stage,
      equipment_id: "",
      scheduled_start: existing?.scheduled_start ?? "",
      scheduled_end: existing?.scheduled_end ?? "",
    };
    onChange({ ...row, equipment_sequence: [...row.equipment_sequence, newSlot] });
  }

  function removeSlotAt(stage: EditableSlot["stage"], idx: number) {
    const stageSlots = slotsForStage(stage);
    if (stageSlots.length <= 1) return; // keep at least one slot per stage
    const toRemove = stageSlots[idx];
    onChange({ ...row, equipment_sequence: row.equipment_sequence.filter((s) => s !== toRemove) });
  }

  function autoFillDates() {
    if (!row.brew_date) return;
    const brewDate = parseISO(row.brew_date);
    const newSeq: EditableSlot[] = [];

    // Fermenter starts same day as brewhouse (beer moves in on brew day).
    // brite starts after fermenter ends.
    const stageStarts: Record<string, Date> = {
      brewhouse: brewDate,
      fermenter: brewDate, // same day as brewhouse
      brite:     addDays(brewDate, stageDays["fermenter"]),
    };

    for (const stage of stages) {
      const stageSlots = slotsForStage(stage);
      const slots = stageSlots.length > 0 ? stageSlots : [{ stage, equipment_id: "", scheduled_start: "", scheduled_end: "" }];
      const start = stageStarts[stage].toISOString().slice(0, 10);
      const end = addDays(stageStarts[stage], stageDays[stage]).toISOString().slice(0, 10);
      for (const s of slots) newSeq.push({ ...s, scheduled_start: start, scheduled_end: end });
    }
    onChange({ ...row, equipment_sequence: newSeq });
  }

  const hasConflict = row.equipment_sequence.some((slot) => slotConflicted(slot, scheduleEntries));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted">Equipment Schedule</span>
        <div className="flex items-center gap-3">
          {hasConflict && <span className="text-xs text-danger">⚠ Schedule conflicts detected</span>}
          <button type="button" onClick={autoFillDates} disabled={!row.brew_date}
            className="btn-secondary">
            Auto-fill dates from brew date
          </button>
        </div>
      </div>
      {stages.map((stage) => {
        const pool = stageEquipment[stage] ?? [];
        const stageSlots = slotsForStage(stage).length > 0
          ? slotsForStage(stage)
          : [{ stage, equipment_id: "", scheduled_start: "", scheduled_end: "" }];
        const maxCapacity = pool.reduce((m, e) => Math.max(m, e.capacity_bbl ?? 0), 0);
        // Brewhouse handles multiple turns sequentially on the same day — capacity is per-turn volume.
        const effectiveVolume = stage === "brewhouse" ? row.volume_bbl / Math.max(row.turns, 1) : row.volume_bbl;
        // Only suggest extra tanks for fermenter/brite (parallel); brewhouse is handled by turns.
        const needsExtraTank = stage !== "brewhouse" && maxCapacity > 0 && effectiveVolume > maxCapacity * stageSlots.length;

        return (
          <div key={stage} className="rounded border border-line px-3 py-2.5 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={`text-xs px-2 py-0.5 rounded border font-mono ${STAGE_COLORS[stage]}`}>
                  {STAGE_LABELS[stage]}
                </span>
                {needsExtraTank && (
                  <span className="text-xs text-accent">⚠ Volume exceeds single tank — add a second tank below</span>
                )}
              </div>
              <button type="button" onClick={() => addTankForStage(stage)}
                className="btn-secondary">
                + Add tank
              </button>
            </div>
            {stageSlots.map((slot, slotIdx) => {
              const conflicted = slotConflicted(slot, scheduleEntries);
              const selectedEq = pool.find((e) => e.id === slot.equipment_id);
              const slotVolume = stage === "brewhouse"
                ? row.volume_bbl / Math.max(row.turns, 1)
                : row.volume_bbl / stageSlots.length;
              const capacityOk = !selectedEq?.capacity_bbl || slotVolume <= selectedEq.capacity_bbl;
              return (
                <div key={slotIdx} className={`rounded border px-2.5 py-2 space-y-1.5 ${conflicted ? "border-danger-border/60 bg-danger-surface/20" : "border-line/60"}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-xs">
                      {stageSlots.length > 1 && <span className="text-faint">Tank {slotIdx + 1}</span>}
                      {conflicted && <span className="text-danger">⚠ Conflict</span>}
                      {!capacityOk && <span className="text-accent">⚠ Exceeds capacity</span>}
                    </div>
                    {stageSlots.length > 1 && (
                      <button type="button" onClick={() => removeSlotAt(stage, slotIdx)}
                        className="btn-danger btn-xxs">Remove</button>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <Field label="Tank">
                      <select className="inp" value={slot.equipment_id}
                        onChange={(e) => updateSlotAt(stage, slotIdx, { equipment_id: e.target.value })}>
                        <option value="">— select —</option>
                        {pool.map((eq) => (
                          <option key={eq.id} value={eq.id}>
                            {eq.name}{eq.capacity_bbl ? ` (${eq.capacity_bbl} BBL)` : ""}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Start">
                      <input type="date" className="inp" value={slot.scheduled_start}
                        onChange={(e) => updateSlotAt(stage, slotIdx, {
                          scheduled_start: e.target.value,
                          scheduled_end: slot.scheduled_end || addDays(parseISO(e.target.value || new Date().toISOString().slice(0, 10)), stageDays[stage]).toISOString().slice(0, 10),
                        })} />
                    </Field>
                    <Field label="End">
                      <input type="date" className="inp" value={slot.scheduled_end}
                        onChange={(e) => updateSlotAt(stage, slotIdx, { scheduled_end: e.target.value })} />
                    </Field>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ─── Allocation plan section ─────────────────────────────────────────────────

function newAlloc(overrides?: Partial<PendingAllocation>): PendingAllocation {
  return {
    id: `alloc-${Date.now()}-${Math.random()}`,
    channel: "taproom",
    percentage: "",
    partner_id: "",
    contract_request_id: "",
    notes: "",
    ...overrides,
  };
}

// ─── Unified Allocation Plan section ─────────────────────────────────────────

const CHANNEL_OPTIONS: { value: AllocationChannel; label: string }[] = [
  { value: "taproom",          label: "Taproom" },
  { value: "distribution",     label: "Distribution" },
  { value: "contract_brewing", label: "Contract Brewing" },
  { value: "wholesale",        label: "Wholesale" },
];

// 25/10/25/10/10/10/10 proportions via fr units; ✕ gets a fixed 20px
const ALLOC_COLS = "25fr 10fr 25fr 10fr 10fr 10fr 10fr 20px";

function AllocationPlanSection({
  row,
  commitments,
  onChange,
}: {
  row: SchedulerRow;
  commitments: ContractBrewingRequest[];
  partners: { id: string; company_name: string }[];
  onChange: (updated: SchedulerRow) => void;
}) {
  const allocs = row.allocations;
  const totalPct = allocs.reduce((s, a) => s + (parseFloat(a.percentage) || 0), 0);
  const remaining = Math.max(0, 100 - totalPct);
  const overAllocated = totalPct > 100;

  const recipeCommitments = commitmentsNeedingBatch(commitments, row.recipe_id);

  function setAlloc(id: string, patch: Partial<PendingAllocation>) {
    onChange({ ...row, allocations: allocs.map((a) => a.id === id ? { ...a, ...patch } : a) });
  }
  function removeAlloc(id: string) {
    onChange({ ...row, allocations: allocs.filter((a) => a.id !== id) });
  }
  function addAlloc() {
    onChange({ ...row, allocations: [...allocs, newAlloc({ percentage: remaining > 0 ? String(Math.round(remaining * 10) / 10) : "" })] });
  }
  function autoFill() {
    onChange({ ...row, allocations: buildAutoAllocations(recipeCommitments, row.volume_bbl) });
  }
  function handleCommitmentChange(id: string, commitmentId: string) {
    const c = commitments.find((x) => x.id === commitmentId);
    setAlloc(id, { contract_request_id: commitmentId, partner_id: c?.partner_id ?? "" });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between">
        <div>
          <span className="text-xs font-medium text-secondary">Allocation Plan</span>
          <p className="text-[11px] text-faint mt-0.5">
            Pre-filled from open commitments. Adjust percentages before committing.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {recipeCommitments.length > 0 && (
            <button type="button" onClick={autoFill}
              className="btn-secondary">
              ↻ Reset from commitments
            </button>
          )}
          <button type="button" onClick={addAlloc}
            className="btn-secondary">
            + Add row
          </button>
        </div>
      </div>

      <div className="rounded border border-line overflow-x-auto">
        {/* Column headers */}
        <div className="grid gap-2 px-3 py-1.5 bg-surface/60 border-b border-line text-[10px] font-medium text-faint uppercase tracking-wide"
          style={{ gridTemplateColumns: ALLOC_COLS }}>
          <span>Channel</span>
          <span>Commitment</span>
          <span>Partner</span>
          <span>Submitted On</span>
          <span>Due</span>
          <span className="text-right">%</span>
          <span className="text-right">BBLs</span>
          <span />
        </div>

        {allocs.length === 0 ? (
          <p className="text-xs text-disabled px-3 py-3">No allocations yet.</p>
        ) : allocs.map((a, idx) => {
          const isTaproom = a.channel === "taproom" || a.channel === "safety_stock";
          const channelCommitments = recipeCommitments.filter((c) => c.channel === a.channel);
          const sel = isTaproom ? null : commitments.find((c) => c.id === a.contract_request_id);
          const pct = parseFloat(a.percentage) || 0;
          const allocBbl = row.volume_bbl > 0 ? (pct / 100) * row.volume_bbl : 0;
          const rowBg = idx % 2 !== 0 ? "bg-surface/25" : "";

          return (
            <div key={a.id} className={`grid gap-2 items-center px-3 py-2 border-b border-line/40 last:border-b-0 ${rowBg}`}
              style={{ gridTemplateColumns: ALLOC_COLS }}>
              {/* Channel */}
              <select className="inp-sm" value={a.channel}
                onChange={(e) => setAlloc(a.id, { channel: e.target.value as AllocationChannel, contract_request_id: "", partner_id: "" })}>
                {CHANNEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>

              {/* Commitment selector */}
              {isTaproom ? (
                <span className="text-xs text-faint italic px-1 truncate">— taproom stock —</span>
              ) : (
                <select className="inp-sm min-w-0" value={a.contract_request_id}
                  onChange={(e) => handleCommitmentChange(a.id, e.target.value)}>
                  <option value="">— select —</option>
                  {channelCommitments.length === 0
                    ? <option disabled value="">No open commitments</option>
                    : channelCommitments.map((c) => {
                        const who = c.contract_brewing_partners?.company_name ?? "No partner";
                        const due = c.desired_delivery_date ? ` · due ${fmtDateLong(c.desired_delivery_date)}` : " · ASAP";
                        return <option key={c.id} value={c.id}>{who} · {uncoveredBbl(c).toFixed(1)} of {Number(c.volume_bbl)} BBL{due}</option>;
                      })}
                </select>
              )}

              {/* Partner — read-only from selected commitment */}
              <span className={`text-xs truncate ${sel?.contract_brewing_partners ? "text-body" : "text-disabled"}`}>
                {sel?.contract_brewing_partners?.company_name ?? (isTaproom ? "" : "—")}
                {a.channel === "contract_brewing" && sel?.contract_brewing_partners && (
                  <span className="ml-1 text-[10px] text-accent-emphasis" title="A deposit invoice will need to be generated for this allocation after the batch is committed.">
                    · deposit req&apos;d
                  </span>
                )}
              </span>

              {/* Submitted On — read-only from selected commitment */}
              <span className={`text-xs truncate tabular-nums ${sel ? "text-secondary" : "text-disabled"}`}>
                {sel
                  ? fmtDateLong((sel.received_on ?? sel.created_at).slice(0, 10))
                  : (isTaproom ? "" : "—")}
              </span>

              {/* Due date — read-only from selected commitment */}
              <span className={`text-xs truncate ${sel?.desired_delivery_date ? "text-secondary" : "text-disabled"}`}>
                {sel?.desired_delivery_date ? fmtDateLong(sel.desired_delivery_date) : (isTaproom ? "" : "—")}
              </span>

              {/* Percentage input */}
              <div className="flex items-center gap-0.5">
                <input type="number" step="0.1" min="0" max="100"
                  className="inp-sm w-full text-right"
                  placeholder="0" value={a.percentage}
                  onChange={(e) => setAlloc(a.id, { percentage: e.target.value })} />
                <span className="text-[10px] text-faint shrink-0">%</span>
              </div>

              {/* BBLs — computed from % × batch volume */}
              <span className={`text-xs text-right tabular-nums pr-1 ${pct > 0 ? "text-body" : "text-disabled"}`}>
                {pct > 0 && row.volume_bbl > 0 ? `${allocBbl.toFixed(1)}` : "—"}
              </span>

              {/* Remove */}
              <button onClick={() => removeAlloc(a.id)}
                className="btn-danger btn-xxs justify-self-center">✕</button>
            </div>
          );
        })}
      </div>

      {/* A deal this batch only partly covers — said out loud, so the rest is a
          decision (second batch, or resize the deal) and not a surprise later. */}
      {allocs.map((a) => {
        const c = commitments.find((x) => x.id === a.contract_request_id);
        if (!c) return null;
        const got = ((parseFloat(a.percentage) || 0) / 100) * row.volume_bbl;
        const left = uncoveredBbl(c) - got;
        if (left < 0.1) return null;
        return (
          <p key={a.id} className="text-xs text-accent-soft">
            {c.contract_brewing_partners?.company_name ?? "This deal"} gets {got.toFixed(1)} of the {uncoveredBbl(c).toFixed(1)} bbl it still needs — {left.toFixed(1)} bbl will need another batch, or a smaller commitment.
          </p>
        );
      })}

      {/* Totals bar */}
      {allocs.length > 0 && (
        <div className="flex items-center gap-3">
          <div className="flex-1 h-1.5 rounded-full bg-surface-mid overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${overAllocated ? "bg-danger-emphasis" : totalPct >= 99 ? "bg-success-emphasis" : "bg-accent-emphasis"}`}
              style={{ width: `${Math.min(totalPct, 100)}%` }}
            />
          </div>
          <span className={`text-xs whitespace-nowrap tabular-nums ${overAllocated ? "text-danger" : "text-muted"}`}>
            {totalPct.toFixed(1)}% · {((totalPct / 100) * row.volume_bbl).toFixed(1)} BBL allocated
            {overAllocated && <span className="ml-1 text-danger">⚠ exceeds 100%</span>}
            {!overAllocated && remaining > 0.1 && <span className="ml-1 text-faint">({remaining.toFixed(1)}% → taproom)</span>}
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export interface CommittedBatch {
  style: string;
  batch_number: string | null;
  brew_date: string;
}

/**
 * The one "schedule a batch" form. Opened from a Plan row or a commitment, it
 * works on ONE beer (`recipeId`): the server's recommendation when there is
 * one, a blank plan for that recipe otherwise. `recipeId: null` = pick the beer.
 */
export default function ScheduleBatchForm({
  recipes,
  tanks,
  partners = [],
  recipeId,
  onCommitted,
  onCancel,
}: {
  recipes: Recipe[];
  tanks: Equipment[];
  partners?: { id: string; company_name: string }[];
  recipeId: string | null;
  onCommitted: (batch: CommittedBatch) => void;
  onCancel: () => void;
}) {
  const qc = useQueryClient();
  // isPending, not isLoading: isLoading is `isPending && isFetching`, so a retry
  // React Query has paused reads as false while there is still no data — the
  // render would fall through to "No batches need scheduling right now" for a
  // load that never landed.
  const { data: schedulerData, isPending: loading, error, refetch } = useQuery({
    queryKey: queryKeys.production.batchScheduler(),
    queryFn: () => fetchJson<SchedulerResponse>("/api/production/batch-scheduler"),
  });
  const recs = schedulerData?.recommendations;
  const warnings = schedulerData?.warnings ?? [];
  const { data: scheduleEntries = [] } = useBatchScheduleQuery();
  const { data: commitments = [] } = useQuery({
    queryKey: queryKeys.production.commitments(),
    queryFn: () => fetchJson<ContractBrewingRequest[]>("/api/production/contract-requests"),
  });

  const [queue, setQueue] = useState<SchedulerRow[]>([]);
  const [committing, setCommitting] = useState(false);
  const [suggesting, setSuggesting] = useState(false);

  // Build the single row this form works on, once the recommendations and the
  // commitments have both loaded. Edits the brewer has made are never replaced.
  useEffect(() => {
    if (!recs) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQueue((prev) => {
      if (prev.length > 0) {
        // Commitments arrived after the row was built: fill an untouched plan.
        return prev.map((row) => row.allocations.length > 0 || !row.recipe_id ? row
          : { ...row, allocations: buildAutoAllocations(commitmentsNeedingBatch(commitments, row.recipe_id), row.volume_bbl) });
      }
      const rec = recipeId ? recs.find((r) => r.recipe_id === recipeId) : undefined;
      const recipe = recipes.find((r) => r.id === recipeId);
      const volume = batchFillBbl(1);
      const row: SchedulerRow = rec ? toRow(rec) : {
        id: `manual-${recipeId ?? "new"}`,
        recipe_id: recipeId ?? "",
        style: recipe?.beer_name ?? "New batch",
        stockout_date: null,
        demand_bbl: 0,
        turns: 1,
        volume_bbl: volume,
        brew_date: new Date().toISOString().slice(0, 10),
        expected_delivery_date: "",
        notes: "",
        equipment_sequence: [],
        allocations: [],
        isManual: true,
        blocked_reason: null,
      };
      const recipeOfRow = recipes.find((r) => r.id === row.recipe_id);
      return [{
        ...row,
        expected_delivery_date: row.expected_delivery_date || calcDeliveryDate(row.brew_date, recipeOfRow),
        allocations: row.recipe_id ? buildAutoAllocations(commitmentsNeedingBatch(commitments, row.recipe_id), row.volume_bbl) : [],
      }];
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recs, commitments]);

  // A beer with no server recommendation still gets tanks suggested, once.
  const [autoSuggested, setAutoSuggested] = useState(false);
  useEffect(() => {
    const row = queue[0];
    if (autoSuggested || !row || !row.isManual || !row.recipe_id || row.volume_bbl <= 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAutoSuggested(true);
    void suggestEquipment(row);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, autoSuggested]);

  const activeRow = useMemo(() => queue[0] ?? null, [queue]);

  // Auto-add extra tank slots for fermenter/brite when volume exceeds single-tank capacity.
  // Brewhouse is handled by turns (sequential same-day runs), so it is excluded.
  useEffect(() => {
    if (!activeRow) return;
    let seq = activeRow.equipment_sequence;
    let changed = false;
    for (const stage of ["fermenter", "brite"] as const) {
      const pool = tanks.filter((t) => t.type === stage);
      const maxCap = pool.reduce((m, e) => Math.max(m, e.capacity_bbl ?? 0), 0);
      if (maxCap <= 0) continue;
      const stageSlots = seq.filter((s) => s.stage === stage);
      if (stageSlots.length === 0) continue; // no anchor slot yet (suggestion hasn't run)
      const needed = Math.min(Math.ceil(activeRow.volume_bbl / maxCap), 4);
      if (needed <= stageSlots.length) continue;
      const anchor = stageSlots[0];
      for (let i = stageSlots.length; i < needed; i++) {
        seq = [...seq, { stage, equipment_id: "", scheduled_start: anchor.scheduled_start, scheduled_end: anchor.scheduled_end }];
      }
      changed = true;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (changed) setQueue((prev) => prev.map((r) => r.id === activeRow.id ? { ...activeRow, equipment_sequence: seq } : r));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRow?.id, activeRow?.volume_bbl, activeRow?.equipment_sequence.length]);

  function updateRow(updated: SchedulerRow) {
    setQueue((prev) => prev.map((r) => r.id === updated.id ? updated : r));
  }

  async function suggestEquipment(row: SchedulerRow) {
    if (!row.recipe_id) return;
    setSuggesting(true);
    try {
      const res = await fetch("/api/production/batch-scheduler/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipe_id: row.recipe_id,
          earliest_start: row.brew_date || undefined,
          volume_bbl: row.volume_bbl || undefined,
          turns: row.turns || 1,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Suggestion failed");
      const result = await res.json() as {
        feasible: boolean;
        recommended_brew_date: string;
        recommended_turns: number;
        recommended_volume_bbl: number;
        equipment_sequence: { stage: "brewhouse" | "fermenter" | "brite"; equipment_id: string; equipment_name: string; scheduled_start: string; scheduled_end: string }[];
      };
      const recipe = recipes.find((r) => r.id === row.recipe_id);
      updateRow({
        ...row,
        brew_date: result.recommended_brew_date,
        expected_delivery_date: calcDeliveryDate(result.recommended_brew_date, recipe),
        turns: result.recommended_turns,
        volume_bbl: result.recommended_volume_bbl,
        equipment_sequence: result.equipment_sequence.map((s) => ({
          stage: s.stage,
          equipment_id: s.equipment_id,
          scheduled_start: s.scheduled_start,
          scheduled_end: s.scheduled_end,
        })),
      });
    } catch (e) {
      alert(e instanceof Error ? e.message : "Suggestion failed");
    } finally {
      setSuggesting(false);
    }
  }

  async function commitBatch(row: SchedulerRow) {
    if (!row.recipe_id) { alert("Please select a recipe."); return; }
    if (!row.brew_date) { alert("Brew date is required."); return; }
    if (row.equipment_sequence.some((s) => !s.equipment_id)) {
      alert("Please assign equipment for all stages."); return;
    }

    const hasConflict = row.equipment_sequence.some((s) => slotConflicted(s, scheduleEntries));
    if (hasConflict) {
      alert("Cannot commit: equipment conflicts detected. Resolve conflicts before committing.");
      return;
    }

    setCommitting(true);
    try {
      const recipe = recipes.find((r) => r.id === row.recipe_id);

      // One call: the server checks the whole plan, then saves the batch, its
      // tank bookings and its allocations together — or nothing at all.
      const batchRes = await fetch("/api/production/batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipe_id: row.recipe_id,
          beer_name: recipe?.beer_name ?? row.style,
          planned_brew_date: row.brew_date,
          expected_delivery_date: row.expected_delivery_date || null,
          volume_bbl: row.volume_bbl,
          turns: row.turns,
          notes: row.notes || null,
          schedule: row.equipment_sequence.map((slot) => ({
            stage: slot.stage,
            equipment_id: slot.equipment_id,
            planned_start: slot.scheduled_start,
            planned_end: slot.scheduled_end,
          })),
          allocations: row.allocations
            .filter((a) => parseFloat(a.percentage) > 0)
            .map((a) => ({
              channel: a.channel,
              percentage: parseFloat(a.percentage),
              partner_id: a.partner_id || null,
              contract_request_id: a.contract_request_id || null,
              notes: a.notes || null,
            })),
        }),
      });
      if (!batchRes.ok) throw new Error((await batchRes.json()).error ?? "Failed to create batch");
      const batch = await batchRes.json();

      await Promise.all([
        refetch(),
        qc.invalidateQueries({ queryKey: queryKeys.production.batchSchedule() }),
        qc.invalidateQueries({ queryKey: queryKeys.production.batches() }),
        qc.invalidateQueries({ queryKey: queryKeys.production.commitments() }),
        qc.invalidateQueries({ queryKey: queryKeys.production.demandCalendar() }),
      ]);
      onCommitted({ style: row.style, batch_number: batch.batch_number ?? null, brew_date: row.brew_date });
    } catch (e) {
      alert(e instanceof Error ? e.message : "Commit failed");
    } finally {
      setCommitting(false);
    }
  }


  if (loading) return <p className="text-faint text-sm py-10 text-center">Loading recommendations…</p>;
  if (error) return <p className="text-sm text-danger py-6">{error instanceof Error ? error.message : "Error"}</p>;

  return (
    <div className="space-y-4">
      {warnings.map((w) => <Banner key={w}>{w}</Banner>)}

      {/* Active batch panel */}
      {activeRow && (
        <div className="rounded-lg border border-line overflow-hidden">
          {/* Title bar */}
          <div className="flex items-center gap-3 px-4 py-3 bg-surface/60 border-b border-line">
            {urgencyBadge(activeRow)}
            <span className="font-semibold text-primary">{activeRow.style}</span>
            {activeRow.demand_bbl > 0 && (
              <span className="text-xs text-muted">{activeRow.demand_bbl.toFixed(1)} BBL demand</span>
            )}
            {!activeRow.isManual && activeRow.stockout_date && (
              <span className="ml-auto text-xs text-success/80 flex items-center gap-1">
                <span>↳ committing will address this stockout</span>
              </span>
            )}
          </div>

          <div className="p-4 space-y-6">
            {activeRow.blocked_reason && (
              <Banner tone="accent">
                This beer needs a batch, but no plan could be built: {activeRow.blocked_reason} You can still set it up by hand below.
              </Banner>
            )}
            {/* Configuration */}
            <div>
              <p className="text-xs font-medium text-muted mb-3">Batch Configuration</p>
              <div className="grid grid-cols-4 gap-3">
                {activeRow.isManual && (
                  <Field label="Recipe" required>
                    <select
                      className="inp"
                      value={activeRow.recipe_id}
                      onChange={(e) => {
                        const r = recipes.find((x) => x.id === e.target.value);
                        const newVol = batchFillBbl(activeRow.turns);
                        const relevant = commitmentsNeedingBatch(commitments, e.target.value);
                        const updated = { ...activeRow, recipe_id: e.target.value, style: r?.style ?? r?.beer_name ?? activeRow.style, volume_bbl: newVol, expected_delivery_date: calcDeliveryDate(activeRow.brew_date, r), allocations: buildAutoAllocations(relevant, newVol) };
                        updateRow(updated);
                        suggestEquipment(updated);
                      }}
                    >
                      <option value="">— select —</option>
                      {recipes.map((r) => <option key={r.id} value={r.id}>{r.beer_name}</option>)}
                    </select>
                  </Field>
                )}
                <Field label="Turns (max 4)" required>
                  <input
                    type="number" step="1" min="1" max="4" className="inp"
                    value={activeRow.turns}
                    onChange={(e) => {
                      const t = Math.min(4, Math.max(1, parseInt(e.target.value) || 1));
                      const newVol = batchFillBbl(t);
                      // Recalculate allocation percentages against the new volume
                      const relevant = commitmentsNeedingBatch(commitments, activeRow.recipe_id);
                      const newAllocs = buildAutoAllocations(relevant, newVol);
                      const updated = { ...activeRow, turns: t, volume_bbl: newVol, allocations: newAllocs };
                      updateRow(updated);
                      if (updated.recipe_id) suggestEquipment(updated);
                    }}
                  />
                </Field>
                <Field label="Brewhouse fill (BBL)">
                  <div className="inp text-secondary">{activeRow.volume_bbl.toFixed(2)}</div>
                </Field>
                <Field label="Brew Date" required>
                  <input
                    type="date" className="inp" value={activeRow.brew_date}
                    onChange={(e) => {
                      const recipe = recipes.find((r) => r.id === activeRow.recipe_id);
                      updateRow({ ...activeRow, brew_date: e.target.value, expected_delivery_date: calcDeliveryDate(e.target.value, recipe) });
                    }}
                  />
                </Field>
                <Field label="Expected Delivery">
                  <input
                    type="date" className="inp" value={activeRow.expected_delivery_date}
                    onChange={(e) => updateRow({ ...activeRow, expected_delivery_date: e.target.value })}
                  />
                  {(() => {
                    const recipe = recipes.find((r) => r.id === activeRow.recipe_id);
                    const lead = recipe ? leadTimeDays(recipe) : 0;
                    return lead > 0 ? <p className="text-xs text-faint mt-1">Auto from recipe: {lead}d lead</p> : null;
                  })()}
                </Field>
                <Field label="Notes">
                  <input className="inp" value={activeRow.notes}
                    onChange={(e) => updateRow({ ...activeRow, notes: e.target.value })} />
                </Field>
              </div>
              {activeRow.isManual && activeRow.recipe_id && (
                <button
                  onClick={() => suggestEquipment(activeRow)}
                  disabled={suggesting}
                  className="btn-secondary mt-2"
                >
                  {suggesting ? "Getting suggestions…" : "↻ Re-suggest equipment"}
                </button>
              )}
            </div>

            {/* Unified allocation plan */}
            <AllocationPlanSection
              row={activeRow}
              commitments={commitments}
              partners={partners}
              onChange={updateRow}
            />

            {/* Equipment schedule */}
            <EquipmentSection
              row={activeRow}
              recipes={recipes}
              tanks={tanks}
              scheduleEntries={scheduleEntries}
              onChange={updateRow}
            />

            {/* Footer */}
            <div className="flex items-center justify-between pt-2 border-t border-line">
              <button onClick={onCancel} className="btn-secondary">Cancel</button>
              {(() => {
                const hasConflict = activeRow.equipment_sequence.some((s) => slotConflicted(s, scheduleEntries));
                const allocTotal = activeRow.allocations.reduce((s, a) => s + (parseFloat(a.percentage) || 0), 0);
                const overAllocated = allocTotal > 100;
                const blocked = committing || !activeRow.recipe_id || !activeRow.brew_date || hasConflict || overAllocated;
                return (
                  <div className="flex flex-col items-end gap-1">
                    {hasConflict && (
                      <span className="text-xs text-danger">Resolve equipment conflicts before committing</span>
                    )}
                    {overAllocated && (
                      <span className="text-xs text-danger">Allocations exceed 100% — reduce before committing</span>
                    )}
                    {!hasConflict && !overAllocated && !activeRow.isManual && activeRow.stockout_date && (
                      <span className="text-xs text-success/70">
                        Will resolve {fmtDateLong(activeRow.stockout_date)} stockout
                      </span>
                    )}
                    <button
                      onClick={() => commitBatch(activeRow)}
                      disabled={blocked}
                      className="btn-primary"
                    >
                      {committing ? "Committing…" : "Commit Batch →"}
                    </button>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
