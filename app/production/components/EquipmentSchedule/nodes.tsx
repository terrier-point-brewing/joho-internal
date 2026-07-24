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

export type EntryNodeData = EntryNodeCallbacks & {
  entry: ScheduleEntry;
  partialDrain?: { arrived: number; departed: number } | null;
  /** Shrinkage lost during packaging (kegging/canning) — shown in red */
  packagingShrinkageBbl?: number;
  /** Shrinkage lost on the outbound transfer to the next pipeline stage — shown in red */
  stageShrinkageBbl?: number;
  /** Volume intentionally converted to another batch (transfer executed) — shown in amber */
  conversionBbl?: number;
  /** Volume planned for conversion but not yet executed — shown in amber */
  pendingConversionBbl?: number;
};

export function EntryNode({ data }: NodeProps) {
  const { entry, onEdit, onSplit, onConvert, onRemove, editing, partialDrain,
          packagingShrinkageBbl, stageShrinkageBbl, conversionBbl, pendingConversionBbl } =
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
          ? style.activeBorder + " ring-2 ring-accent/40 border-2"
          : style.border + " border hover:border-opacity-100"}`}
    >
      <Handle type="target" position={Position.Left}  style={HS} />
      <Handle type="source" position={Position.Right} style={HS} />

      <div className={`h-0.5 w-full rounded-t-lg ${isDone ? "bg-success" : isActive ? "bg-accent" : "bg-line-strong"}`} />
      <div className="p-3">
        <div className="flex items-center justify-between mb-2">
          <span className={`text-[10px] font-bold uppercase tracking-wider ${style.label}`}>
            {STAGE_LABELS[entry.stage] ?? entry.stage}
          </span>
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
            isDone   ? "bg-success-surface text-success"
            : isActive ? "bg-accent-muted text-accent"
            : "bg-surface-mid text-muted"
          }`}>
            {isDone ? "Done" : isActive ? "Active" : "Planned"}
          </span>
        </div>
        <p className="text-xs font-semibold text-strong truncate mb-2 min-h-[1rem]">
          {entry.equipment?.name
            ?? <span className="text-faint font-normal italic">No tank assigned</span>}
        </p>
        {entry.volume_bbl != null && (
          partialDrain ? (
            <p className="text-[11px] text-muted mb-1">
              {Number(entry.volume_bbl).toFixed(2)} / {partialDrain.arrived.toFixed(2)} BBL
              <span className="text-faint"> remaining</span>
            </p>
          ) : (
            <p className="text-[11px] text-muted mb-1">{fmtBbl2(entry.volume_bbl)}</p>
          )
        )}
        {packagingShrinkageBbl != null && (
          <p className="text-[11px] text-danger mb-1">−{packagingShrinkageBbl.toFixed(2)} BBL loss</p>
        )}
        {stageShrinkageBbl != null && (
          <p className="text-[11px] text-danger mb-1">−{stageShrinkageBbl.toFixed(2)} BBL lost</p>
        )}
        {conversionBbl != null && (
          <p className="text-[11px] text-[var(--cat-amber-fg)] mb-1">→ {conversionBbl.toFixed(2)} BBL converted</p>
        )}
        {pendingConversionBbl != null && (
          <p className="text-[11px] text-[var(--cat-amber-fg)] mb-1">→ {pendingConversionBbl.toFixed(2)} BBL converting</p>
        )}
        <div className="text-[11px] text-secondary space-y-0.5">
          {entry.actual_start ? (
            <div className="flex items-center gap-1">
              <span className="text-success">●</span>
              <span>{fmtShort(entry.actual_start)}</span>
              {entry.actual_end && (
                <><span className="text-faint">→</span><span>{fmtShort(entry.actual_end)}</span></>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-1 text-muted">
              <span className="text-disabled">○</span>
              <span>{fmtShort(entry.planned_start)}</span>
              <span className="text-disabled">→</span>
              <span>{fmtShort(entry.planned_end)}</span>
            </div>
          )}
          <div className="text-faint">{days}d</div>
        </div>
      </div>

      {/* Remove */}
      <button type="button"
        onClick={ev => { ev.stopPropagation(); (onRemove as EntryNodeCallbacks["onRemove"])(entry.id); }}
        className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 text-faint hover:text-danger text-xs transition-opacity leading-none"
        title="Remove">×</button>

      {/* Split / Convert */}
      {(canSplit || canConvert) && (
        <div className="absolute bottom-1.5 left-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1.5">
          {canSplit && (
            <button type="button"
              onClick={ev => { ev.stopPropagation(); (onSplit as EntryNodeCallbacks["onSplit"])(entry); }}
              className="text-[10px] text-info hover:text-info border border-info-border px-1.5 py-0.5 rounded transition-colors bg-surface/80">
              ⎇ Split
            </button>
          )}
          {canConvert && (
            <button type="button"
              onClick={ev => { ev.stopPropagation(); (onConvert as EntryNodeCallbacks["onConvert"])(entry); }}
              className="text-[10px] text-[var(--cat-amber-fg)] border border-[var(--cat-amber-bd)] px-1.5 py-0.5 rounded transition-colors bg-surface/80">
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
          ? "border-line-subtle hover:border-accent-border bg-surface/20 hover:bg-accent-muted/20"
          : "border-line-strong hover:border-line-subtle bg-surface/10 hover:bg-surface-mid/20"}`}
    >
      <Handle type="target" position={Position.Left}  style={HS} />
      <Handle type="source" position={Position.Right} style={HS} />

      <div className={`h-0.5 w-full rounded-t-lg ${isRequired ? "bg-line-strong/50" : "bg-surface-mid/30"}`} />
      <div className="p-3 flex flex-col items-start justify-center min-h-[96px] gap-1">
        <span className={`text-[10px] font-bold uppercase tracking-wider ${isRequired ? "text-muted" : "text-faint"}`}>
          {label as string}
        </span>
        <span className={`text-xs ${isRequired ? "text-muted" : "text-faint"}`}>
          {isRequired ? "Not scheduled" : `+ Add ${(label as string).toLowerCase()}`}
        </span>
        {isRequired && (
          <span className="text-[10px] text-[var(--cat-amber-fg)] mt-0.5">⚠ Schedule needed</span>
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
    <div className="w-44 rounded-lg border border-dashed border-[var(--cat-amber-bd)] bg-[var(--cat-amber-bg)] select-none">
      <Handle type="target" position={Position.Left} style={HS} />
      <div className="h-0.5 w-full rounded-t-lg bg-[var(--cat-amber-bd)]" />
      <div className="p-3 min-h-[96px] flex flex-col justify-center gap-1">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--cat-amber-fg)]">
          {isExecuted ? "Converted →" : "Planned conversion →"}
        </span>
        <p className="text-xs font-semibold text-[var(--cat-amber-fg)] truncate">{toBatch.beer_name}</p>
        {toBatch.batch_number && (
          <p className="text-[10px] font-mono text-[var(--cat-amber-fg)]">#{toBatch.batch_number}</p>
        )}
        <p className="text-[10px] text-[var(--cat-amber-fg)] mt-0.5">{fmtBbl2(volumeBbl)}</p>
        {destinationEquipmentName && (
          <p className="text-[10px] text-[var(--cat-amber-fg)] truncate">→ {destinationEquipmentName}</p>
        )}
        {plannedDate && (
          <p className="text-[10px] text-[var(--cat-amber-fg)]">{fmtShort(plannedDate)}</p>
        )}
      </div>
    </div>
  );
}
