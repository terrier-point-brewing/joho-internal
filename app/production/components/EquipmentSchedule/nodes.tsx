"use client";

import React from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { fmtBbl2 } from "@/lib/utils/formatting";
import type { ScheduleEntry } from "../../hooks/queries";
import {
  STAGE_LABELS, STAGE_CARD_STYLE, SPLITTABLE_STAGES, CONVERTIBLE_STAGES,
  stageDuration, fmtShort,
} from "./constants";

// ── Shared handle style ───────────────────────────────────────────────────
const HS: React.CSSProperties = {
  background: "transparent",
  border: "none",
  width: 0,
  height: 0,
};

// ── Entry node ────────────────────────────────────────────────────────────
export type EntryNodeCallbacks = {
  onEdit:    (e: ScheduleEntry) => void;
  onSplit:   (e: ScheduleEntry) => void;
  onConvert: (e: ScheduleEntry) => void;
  onRemove:  (id: string) => void;
  editing:   ScheduleEntry | null;
};

export type EntryNodeData = EntryNodeCallbacks & { entry: ScheduleEntry };

export function EntryNode({ data }: NodeProps) {
  const { entry, onEdit, onSplit, onConvert, onRemove, editing } =
    data as EntryNodeData;

  const norm      = entry.stage === "fermenter" ? "fermenting" : entry.stage;
  const style     = STAGE_CARD_STYLE[norm] ?? STAGE_CARD_STYLE.cold_storage;
  const isEditing = (editing as ScheduleEntry | null)?.id === entry.id;
  const isDone    = !!entry.actual_end;
  const isActive  = !!entry.actual_start && !isDone;
  const days      = stageDuration(entry);
  const canSplit  = SPLITTABLE_STAGES.has(norm);
  const canConvert = CONVERTIBLE_STAGES.has(norm);

  return (
    <div
      onClick={() => (onEdit as EntryNodeCallbacks["onEdit"])(entry)}
      className={`relative group w-44 rounded-lg border cursor-pointer transition-all select-none
        ${style.bg}
        ${isEditing
          ? style.activeBorder + " ring-2 ring-amber-600/40 border-2"
          : style.border + " border hover:border-opacity-100"}`}
    >
      <Handle type="target" position={Position.Left}  style={HS} />
      <Handle type="source" position={Position.Right} style={HS} />

      <div className={`h-0.5 w-full rounded-t-lg ${isDone ? "bg-emerald-500" : isActive ? "bg-amber-400" : "bg-zinc-700"}`} />
      <div className="p-3">
        <div className="flex items-center justify-between mb-2">
          <span className={`text-[10px] font-bold uppercase tracking-wider ${style.label}`}>
            {STAGE_LABELS[entry.stage] ?? entry.stage}
          </span>
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
            isDone   ? "bg-emerald-900/50 text-emerald-400"
            : isActive ? "bg-amber-900/50 text-amber-400"
            : "bg-zinc-800 text-zinc-500"
          }`}>
            {isDone ? "Done" : isActive ? "Active" : "Planned"}
          </span>
        </div>
        <p className="text-xs font-semibold text-zinc-200 truncate mb-2 min-h-[1rem]">
          {entry.equipment?.name
            ?? <span className="text-zinc-600 font-normal italic">No tank assigned</span>}
        </p>
        {entry.volume_bbl != null && (
          <p className="text-[11px] text-zinc-500 mb-1">{fmtBbl2(entry.volume_bbl)}</p>
        )}
        <div className="text-[11px] text-zinc-400 space-y-0.5">
          {entry.actual_start ? (
            <div className="flex items-center gap-1">
              <span className="text-emerald-500">●</span>
              <span>{fmtShort(entry.actual_start)}</span>
              {entry.actual_end && (
                <><span className="text-zinc-600">→</span><span>{fmtShort(entry.actual_end)}</span></>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-1 text-zinc-500">
              <span className="text-zinc-700">○</span>
              <span>{fmtShort(entry.planned_start)}</span>
              <span className="text-zinc-700">→</span>
              <span>{fmtShort(entry.planned_end)}</span>
            </div>
          )}
          <div className="text-zinc-600">{days}d</div>
        </div>
      </div>

      {/* Remove */}
      <button type="button"
        onClick={ev => { ev.stopPropagation(); (onRemove as EntryNodeCallbacks["onRemove"])(entry.id); }}
        className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 text-xs transition-opacity leading-none"
        title="Remove">×</button>

      {/* Split / Convert */}
      {(canSplit || canConvert) && (
        <div className="absolute bottom-1.5 left-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1.5">
          {canSplit && (
            <button type="button"
              onClick={ev => { ev.stopPropagation(); (onSplit as EntryNodeCallbacks["onSplit"])(entry); }}
              className="text-[10px] text-blue-400 hover:text-blue-300 border border-blue-800/50 px-1.5 py-0.5 rounded transition-colors bg-zinc-900/80">
              ⎇ Split
            </button>
          )}
          {canConvert && (
            <button type="button"
              onClick={ev => { ev.stopPropagation(); (onConvert as EntryNodeCallbacks["onConvert"])(entry); }}
              className="text-[10px] text-amber-400 hover:text-amber-300 border border-amber-800/50 px-1.5 py-0.5 rounded transition-colors bg-zinc-900/80">
              → Convert
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Ghost node ────────────────────────────────────────────────────────────
export type GhostNodeData = {
  stage:      string;
  label:      string;
  isRequired: boolean;
  onBuild:    () => void;
};

export function GhostNode({ data }: NodeProps) {
  const { label, isRequired, onBuild } = data as GhostNodeData;
  return (
    <div
      onClick={() => (onBuild as () => void)()}
      className={`w-44 rounded-lg border border-dashed cursor-pointer transition-all select-none
        ${isRequired
          ? "border-zinc-600 hover:border-amber-600/60 bg-zinc-900/20 hover:bg-amber-950/10"
          : "border-zinc-700 hover:border-zinc-500 bg-zinc-900/10 hover:bg-zinc-800/20"}`}
    >
      <Handle type="target" position={Position.Left}  style={HS} />
      <Handle type="source" position={Position.Right} style={HS} />

      <div className={`h-0.5 w-full rounded-t-lg ${isRequired ? "bg-zinc-700/50" : "bg-zinc-800/30"}`} />
      <div className="p-3 flex flex-col items-start justify-center min-h-[96px] gap-1">
        <span className={`text-[10px] font-bold uppercase tracking-wider ${isRequired ? "text-zinc-500" : "text-zinc-600"}`}>
          {label as string}
        </span>
        <span className={`text-xs ${isRequired ? "text-zinc-500" : "text-zinc-600"}`}>
          {isRequired ? "Not scheduled" : `+ Add ${(label as string).toLowerCase()}`}
        </span>
        {isRequired && (
          <span className="text-[10px] text-amber-600/70 mt-0.5">⚠ Schedule needed</span>
        )}
      </div>
    </div>
  );
}

// ── Conversion node ───────────────────────────────────────────────────────
export type ConversionNodeData = {
  toBatch:                  { beer_name: string; batch_number: string | null };
  volumeBbl:                number;
  plannedDate?:              string | null;
  destinationEquipmentName?: string | null;
  isExecuted?:               boolean;
};

export function ConversionNode({ data }: NodeProps) {
  const { toBatch, volumeBbl, plannedDate, destinationEquipmentName, isExecuted } = data as ConversionNodeData;
  return (
    <div className="w-44 rounded-lg border border-dashed border-amber-700/50 bg-amber-950/20 select-none">
      <Handle type="target" position={Position.Left} style={HS} />
      <div className="h-0.5 w-full rounded-t-lg bg-amber-700/40" />
      <div className="p-3 min-h-[96px] flex flex-col justify-center gap-1">
        <span className="text-[10px] font-bold uppercase tracking-wider text-amber-500">
          {isExecuted ? "Converted →" : "Planned conversion →"}
        </span>
        <p className="text-xs font-semibold text-amber-300 truncate">{toBatch.beer_name}</p>
        {toBatch.batch_number && (
          <p className="text-[10px] font-mono text-amber-600">#{toBatch.batch_number}</p>
        )}
        <p className="text-[10px] text-amber-700 mt-0.5">{fmtBbl2(volumeBbl)}</p>
        {destinationEquipmentName && (
          <p className="text-[10px] text-amber-700/80 truncate">→ {destinationEquipmentName}</p>
        )}
        {plannedDate && (
          <p className="text-[10px] text-amber-700/80">{fmtShort(plannedDate)}</p>
        )}
      </div>
    </div>
  );
}
