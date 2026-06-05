"use client";

import { useState, useMemo } from "react";
import {
  format, startOfMonth, endOfMonth, startOfWeek, endOfWeek,
  addDays, addMonths, subMonths, isSameMonth, isSameDay,
  parseISO, startOfDay, endOfDay,
} from "date-fns";
import { BrewBatch } from "../types";
import { useBatchScheduleQuery } from "../hooks/queries";

interface Props {
  batches: BrewBatch[];
}

const BATCH_PALETTE = [
  "#f59e0b", "#3b82f6", "#10b981", "#8b5cf6",
  "#f43f5e", "#06b6d4", "#f97316", "#14b8a6",
  "#a855f7", "#84cc16", "#ec4899", "#6366f1",
];

const STAGE_LABELS: Record<string, string> = {
  brewhouse: "Brew",
  fermenting: "Ferment",
  conditioning: "Condition",
  kegging: "Keg",
  canning: "Can",
  cold_storage: "Cold",
};

export default function CalendarTab({ batches }: Props) {
  const { data: entries = [] } = useBatchScheduleQuery();
  const [currentMonth, setCurrentMonth] = useState(() => startOfMonth(new Date()));

  // Stable color map per batch
  const batchColors = useMemo(() => {
    const map: Record<string, string> = {};
    batches.forEach((b, i) => { map[b.id] = BATCH_PALETTE[i % BATCH_PALETTE.length]; });
    return map;
  }, [batches]);

  // Build calendar grid: 6 weeks of days
  const calStart = startOfWeek(startOfMonth(currentMonth));
  const calEnd = endOfWeek(endOfMonth(currentMonth));
  const days: Date[] = [];
  let d = calStart;
  while (d <= calEnd) { days.push(d); d = addDays(d, 1); }

  function entriesOnDay(day: Date) {
    const dayStart = startOfDay(day);
    const dayEnd = endOfDay(day);
    return entries.filter(e => {
      try {
        const s = parseISO(e.planned_start);
        const en = parseISO(e.planned_end);
        return s <= dayEnd && en >= dayStart;
      } catch { return false; }
    });
  }

  const today = new Date();

  return (
    <div>
      {/* Month nav */}
      <div className="flex items-center gap-3 mb-4">
        <button onClick={() => setCurrentMonth(m => subMonths(m, 1))} className="px-3 py-1 text-sm bg-zinc-800 rounded text-zinc-400 hover:text-zinc-200">‹</button>
        <h2 className="text-base font-semibold text-zinc-200 min-w-[140px] text-center">{format(currentMonth, "MMMM yyyy")}</h2>
        <button onClick={() => setCurrentMonth(m => addMonths(m, 1))} className="px-3 py-1 text-sm bg-zinc-800 rounded text-zinc-400 hover:text-zinc-200">›</button>
        <button onClick={() => setCurrentMonth(startOfMonth(today))} className="px-3 py-1 text-xs bg-zinc-800 rounded text-zinc-400 hover:text-zinc-200">Today</button>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 mb-1">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(dow => (
          <div key={dow} className="text-xs text-zinc-500 font-medium text-center py-1">{dow}</div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 gap-px bg-zinc-700 border border-zinc-700 rounded-lg overflow-hidden">
        {days.map(day => {
          const inMonth = isSameMonth(day, currentMonth);
          const isToday = isSameDay(day, today);
          const dayEntries = entriesOnDay(day);
          return (
            <div
              key={day.toISOString()}
              className={`min-h-[100px] p-1.5 flex flex-col gap-0.5 ${inMonth ? "bg-zinc-900" : "bg-zinc-950"}`}
            >
              <span className={`text-xs font-medium mb-0.5 w-6 h-6 flex items-center justify-center rounded-full ${
                isToday ? "bg-amber-500 text-black" : inMonth ? "text-zinc-300" : "text-zinc-600"
              }`}>
                {format(day, "d")}
              </span>
              {dayEntries.slice(0, 3).map(entry => {
                const color = batchColors[entry.batch_id] ?? "#6b7280";
                const batchName = entry.brew_batches
                  ? `#${entry.brew_batches.batch_number} ${entry.brew_batches.beer_name}`
                  : "?";
                const stage = STAGE_LABELS[entry.stage] ?? entry.stage;
                const eqName = entry.equipment?.name;
                return (
                  <div
                    key={entry.id}
                    title={`${batchName} — ${stage}${eqName ? ` (${eqName})` : ""}`}
                    className="text-xs px-1.5 py-0.5 rounded truncate text-white font-medium"
                    style={{ background: color + "cc" }}
                  >
                    {batchName} <span className="opacity-70 text-[10px]">{stage}</span>
                  </div>
                );
              })}
              {dayEntries.length > 3 && (
                <span className="text-[10px] text-zinc-500 pl-1">+{dayEntries.length - 3} more</span>
              )}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      {batches.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-3">
          {batches.slice(0, 12).map((b, i) => (
            <div key={b.id} className="flex items-center gap-1.5 text-xs text-zinc-400">
              <div className="w-3 h-3 rounded-sm flex-none" style={{ background: BATCH_PALETTE[i % BATCH_PALETTE.length] }} />
              #{b.batch_number} {b.beer_name}
            </div>
          ))}
        </div>
      )}

      {entries.length === 0 && (
        <p className="mt-6 text-sm text-zinc-500 text-center">No schedule entries yet. Add them from the Timeline tab.</p>
      )}
    </div>
  );
}
