"use client";

import React from "react";
import { fmtBbl2 } from "@/lib/utils/formatting";
import type { ScheduleEntry } from "../../hooks/queries";
import type { FlowItem } from "./types";
import {
  STAGE_LABELS, STAGE_CARD_STYLE, SPLITTABLE_STAGES, CONVERTIBLE_STAGES,
  stageDuration, fmtShort,
} from "./constants";

export interface FlowNodeCallbacks {
  onEdit:     (e: ScheduleEntry) => void;
  onBuild:    () => void;
  onSplit:    (e: ScheduleEntry) => void;
  onConvert:  (e: ScheduleEntry) => void;
  onRemove:   (id: string) => void;
  editing:    ScheduleEntry | null;
}

function EntryCard({
  entry,
  callbacks,
}: {
  entry: ScheduleEntry;
  callbacks: FlowNodeCallbacks;
}) {
  const { onEdit, onSplit, onConvert, onRemove, editing } = callbacks;
  const norm      = entry.stage === "fermenter" ? "fermenting" : entry.stage;
  const style     = STAGE_CARD_STYLE[norm] ?? STAGE_CARD_STYLE.cold_storage;
  const isEditing = editing?.id === entry.id;
  const isDone    = !!entry.actual_end;
  const isActive  = !!entry.actual_start && !isDone;
  const days      = stageDuration(entry);
  const canSplit  = SPLITTABLE_STAGES.has(norm);
  const canConvert= CONVERTIBLE_STAGES.has(norm);

  return (
    <div
      onClick={() => onEdit(entry)}
      className={`relative group flex-none w-44 rounded-lg border cursor-pointer transition-all select-none
        ${style.bg}
        ${isEditing
          ? style.activeBorder + " ring-2 ring-amber-600/40 border-2"
          : style.border + " border hover:border-opacity-100"}`}
    >
      <div className={`h-0.5 w-full rounded-t-lg ${isDone ? "bg-emerald-500" : isActive ? "bg-amber-400" : "bg-zinc-700"}`} />
      <div className="p-3">
        <div className="flex items-center justify-between mb-2">
          <span className={`text-[10px] font-bold uppercase tracking-wider ${style.label}`}>
            {STAGE_LABELS[entry.stage] ?? entry.stage}
          </span>
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
            isDone ? "bg-emerald-900/50 text-emerald-400" : isActive ? "bg-amber-900/50 text-amber-400" : "bg-zinc-800 text-zinc-500"
          }`}>{isDone ? "Done" : isActive ? "Active" : "Planned"}</span>
        </div>
        <p className="text-xs font-semibold text-zinc-200 truncate mb-2 min-h-[1rem]">
          {entry.equipment?.name ?? <span className="text-zinc-600 font-normal italic">No tank assigned</span>}
        </p>
        {entry.volume_bbl != null && (
          <p className="text-[11px] text-zinc-500 mb-1">{fmtBbl2(entry.volume_bbl)}</p>
        )}
        <div className="text-[11px] text-zinc-400 space-y-0.5">
          {entry.actual_start ? (
            <div className="flex items-center gap-1">
              <span className="text-emerald-500">●</span>
              <span>{fmtShort(entry.actual_start)}</span>
              {entry.actual_end && <><span className="text-zinc-600">→</span><span>{fmtShort(entry.actual_end)}</span></>}
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

      <button type="button"
        onClick={ev => { ev.stopPropagation(); onRemove(entry.id); }}
        className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 text-xs transition-opacity leading-none"
        title="Remove">×</button>

      {(canSplit || canConvert) && (
        <div className="absolute bottom-1.5 left-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1.5">
          {canSplit && (
            <button type="button"
              onClick={ev => { ev.stopPropagation(); onSplit(entry); }}
              className="text-[10px] text-blue-400 hover:text-blue-300 border border-blue-800/50 px-1.5 py-0.5 rounded transition-colors bg-zinc-900/80"
              title="Plan a split branch from this stage">
              ⎇ Split
            </button>
          )}
          {canConvert && (
            <button type="button"
              onClick={ev => { ev.stopPropagation(); onConvert(entry); }}
              className="text-[10px] text-amber-400 hover:text-amber-300 border border-amber-800/50 px-1.5 py-0.5 rounded transition-colors bg-zinc-900/80"
              title="Plan a conversion to a new batch">
              → Convert
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function GhostCard({ item, onBuild }: { item: Extract<FlowItem, { kind: "ghost" }>; onBuild: () => void }) {
  const { isRequired, label } = item;
  return (
    <div
      onClick={onBuild}
      className={`flex-none w-44 rounded-lg border border-dashed cursor-pointer transition-all select-none
        ${isRequired
          ? "border-zinc-600 hover:border-amber-600/60 bg-zinc-900/20 hover:bg-amber-950/10"
          : "border-zinc-700 hover:border-zinc-500 bg-zinc-900/10 hover:bg-zinc-800/20"}`}
    >
      <div className={`h-0.5 w-full rounded-t-lg ${isRequired ? "bg-zinc-700/50" : "bg-zinc-800/30"}`} />
      <div className="p-3 flex flex-col items-start justify-center min-h-[96px] gap-1">
        <span className={`text-[10px] font-bold uppercase tracking-wider ${isRequired ? "text-zinc-500" : "text-zinc-600"}`}>
          {label}
        </span>
        <span className={`text-xs ${isRequired ? "text-zinc-500" : "text-zinc-600"}`}>
          {isRequired ? "Not scheduled" : `+ Add ${label.toLowerCase()}`}
        </span>
        {isRequired && <span className="text-[10px] text-amber-600/70 mt-0.5">⚠ Schedule needed</span>}
      </div>
    </div>
  );
}

// Arrow connector between nodes
function Arrow() {
  return (
    <div className="flex-none flex items-center w-10">
      <div className="flex-1 border-t border-dashed border-zinc-600" />
      <span className="text-zinc-500 text-sm">›</span>
    </div>
  );
}

export function FlowNode({
  item,
  callbacks,
}: {
  item: FlowItem;
  callbacks: FlowNodeCallbacks;
}) {
  // Packaging group: conditioning column + dashed Packaging box
  if (item.kind === "packaging_group") {
    const { tracks } = item;
    const multi = tracks.length > 1;

    return (
      <div className="flex items-start gap-0">
        {/* Conditioning column — one card per track */}
        <div className="flex flex-col gap-3 py-1">
          {tracks.map((track, i) => (
            <div key={i} className="flex items-center min-h-[96px]">
              <FlowNode item={track.conditioning} callbacks={callbacks} />
            </div>
          ))}
        </div>

        {/* Connector(s) from conditioning to the packaging box */}
        {multi ? (
          <>
            {/* Vertical line clipped to span only between arrow midpoints */}
            <div className="flex-none self-stretch" style={{ paddingTop: "52px", paddingBottom: "52px" }}>
              <div className="h-full border-l border-dashed border-zinc-600" />
            </div>
            {/* Branch arrows — one per track, matching the conditioning column rows */}
            <div className="flex flex-col gap-3 py-1">
              {tracks.map((_, i) => (
                <div key={i} className="flex items-center min-h-[96px]">
                  <div className="w-6 border-t border-dashed border-zinc-600" />
                  <span className="text-zinc-500 text-sm mr-0.5">›</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <Arrow />
        )}

        {/* Packaging box */}
        <div className="relative rounded-xl border border-dashed border-zinc-700/50 px-3 py-1">
          <span className="absolute -top-2.5 left-3 bg-zinc-950 px-1 text-[9px] text-zinc-500 uppercase tracking-widest font-medium">
            Packaging
          </span>
          <div className="flex flex-col gap-3">
            {tracks.map((track, i) => (
              <div key={i} className="flex items-center gap-0">
                {track.items.map((pkgItem, j) => (
                  <React.Fragment key={j}>
                    {j > 0 && <Arrow />}
                    <FlowNode item={pkgItem} callbacks={callbacks} />
                  </React.Fragment>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const card = (() => {
    if (item.kind === "conversion") {
      return (
        <div className="flex-none w-44 rounded-lg border border-dashed border-amber-700/50 bg-amber-950/20 select-none">
          <div className="h-0.5 w-full rounded-t-lg bg-amber-700/40" />
          <div className="p-3 min-h-[96px] flex flex-col justify-center gap-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-amber-500">Converted →</span>
            <p className="text-xs font-semibold text-amber-300 truncate">{item.toBatch.beer_name}</p>
            {item.toBatch.batch_number && (
              <p className="text-[10px] font-mono text-amber-600">#{item.toBatch.batch_number}</p>
            )}
            <p className="text-[10px] text-amber-700 mt-0.5">{fmtBbl2(item.volumeBbl)}</p>
          </div>
        </div>
      );
    }

    if (item.kind === "planned_conversion") {
      return (
        <div className="flex-none w-44 rounded-lg border border-dashed border-amber-700/40 bg-amber-950/10 select-none">
          <div className="h-0.5 w-full rounded-t-lg bg-amber-700/30" />
          <div className="p-3 min-h-[96px] flex flex-col justify-center gap-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-amber-600">→ Convert (planned)</span>
            <p className="text-xs font-semibold text-amber-400 truncate">{item.beerName}</p>
            <p className="text-[10px] text-amber-700">{fmtBbl2(item.volumeBbl)}</p>
          </div>
        </div>
      );
    }

    if (item.kind === "ghost") {
      return <GhostCard item={item} onBuild={callbacks.onBuild} />;
    }

    if (item.kind !== "entry") return null;
    return <EntryCard entry={item.entry} callbacks={callbacks} />;
  })();

  const { children } = item;

  if (!children.length) return <div className="flex-none">{card}</div>;

  if (children.length === 1) {
    return (
      <div className="flex items-center gap-0">
        <div className="flex-none">{card}</div>
        <Arrow />
        <FlowNode item={children[0]} callbacks={callbacks} />
      </div>
    );
  }

  // Fork: multiple children (used for splits / conversions, not packaging)
  // Vertical line inset by 52px (48px half-card + 4px py-1) to clip at arrow midpoints.
  return (
    <div className="flex items-center gap-0">
      <div className="flex-none">{card}</div>
      <div className="flex-none w-6 flex items-center self-stretch">
        <div className="w-full border-t border-dashed border-zinc-600" />
      </div>
      <div className="flex-none self-stretch" style={{ paddingTop: "52px", paddingBottom: "52px" }}>
        <div className="h-full border-l border-dashed border-zinc-600" />
      </div>
      <div className="flex flex-col gap-3 py-1">
        {children.map((child, i) => (
          <div key={i} className="flex items-center">
            <div className="w-6 border-t border-dashed border-zinc-600" />
            <span className="text-zinc-500 text-sm mr-0.5">›</span>
            <FlowNode item={child} callbacks={callbacks} />
          </div>
        ))}
      </div>
    </div>
  );
}
