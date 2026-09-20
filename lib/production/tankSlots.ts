// lib/production/tankSlots.ts
//
// One tank-slot finder for Intake's recommendations AND the "suggest" endpoint
// (Intake's manual rows, Brewing's Build Schedule panel). There used to be two
// copies: one ignored tanks that are physically occupied, the other dropped any
// batch too big for a single tank without saying so.

import { addDays, parseISO } from "date-fns";

export interface SlotTank {
  id: string;
  name: string;
  type: string;
  capacity_bbl: number | null;
}

export interface SlotBusyEntry {
  equipment_id: string | null;
  planned_start: string;
  planned_end: string;
  actual_start?: string | null;
  actual_end?: string | null;
  cancelled_at?: string | null;
}

export interface PlannedSlot {
  stage: "brewhouse" | "fermenter" | "brite";
  equipment_id: string;
  equipment_name: string;
  scheduled_start: string;
  scheduled_end: string;
  volume_bbl: number;
}

export interface TankPlan {
  feasible: boolean;
  /** Why no plan was found, in plain words. null when feasible. */
  reason: string | null;
  sequence: PlannedSlot[];
}

/** How long a tank that is occupied but has no schedule entry is assumed busy. */
export const UNSCHEDULED_OCCUPANCY_DAYS = 60;
/** Fermenter/brite stages may split across this many parallel tanks. */
const MAX_PARALLEL_TANKS = 2;

const STAGE_LABEL = { brewhouse: "brewhouse", fermenter: "fermenter", brite: "brite tank" } as const;
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Tanks holding beer right now with no schedule entry still count as busy. */
export function occupiedTanksAsEntries(
  assignments: Array<{ tank_id: string; assigned_at: string }>,
  entries: SlotBusyEntry[],
  now = new Date(),
): SlotBusyEntry[] {
  const scheduled = new Set(entries.map((e) => e.equipment_id).filter(Boolean));
  return assignments
    .filter((a) => !scheduled.has(a.tank_id))
    .map((a) => ({
      equipment_id: a.tank_id,
      planned_start: a.assigned_at,
      planned_end: addDays(now, UNSCHEDULED_OCCUPANCY_DAYS).toISOString(),
      actual_start: a.assigned_at,
    }));
}

function earliestFree(tank: SlotTank, days: number, from: Date, entries: SlotBusyEntry[], volumeBbl: number): Date | null {
  if (tank.capacity_bbl != null && volumeBbl > tank.capacity_bbl) return null;
  const busy = entries
    .filter((e) => e.equipment_id === tank.id && !e.cancelled_at)
    .map((e) => ({ start: parseISO(e.actual_start ?? e.planned_start), end: parseISO(e.actual_end ?? e.planned_end) }));
  let candidate = new Date(from);
  for (let attempt = 0; attempt < 365; attempt++) {
    const end = addDays(candidate, days);
    const clash = busy.find((b) => candidate < b.end && end > b.start);
    if (!clash) return candidate;
    candidate = new Date(clash.end);
  }
  return null;
}

export function planTankSlots(input: {
  tanks: SlotTank[];
  entries: SlotBusyEntry[];
  volumeBbl: number;
  turns: number;
  startDate: Date;
  days: { brewhouse: number; fermenter: number; brite: number };
}): TankPlan {
  const { tanks, entries, volumeBbl, startDate, days } = input;
  const turns = Math.max(1, input.turns);
  const sequence: PlannedSlot[] = [];
  let stageStart = startDate;
  let brewDay = startDate;

  for (const stage of ["brewhouse", "fermenter", "brite"] as const) {
    const pool = tanks.filter((t) => t.type === stage);
    if (pool.length === 0) return { feasible: false, reason: `No ${STAGE_LABEL[stage]} is set up in Equipment.`, sequence: [] };

    // Turns run through the brewhouse one after another, so it only has to fit
    // one turn. The beer moves to the fermenter on brew day.
    const stageVolume = stage === "brewhouse" ? volumeBbl / turns : volumeBbl;
    const from = stage === "fermenter" ? brewDay : stageStart;

    let placed: Array<{ tank: SlotTank; start: Date }> = [];
    const splits = stage === "brewhouse" ? 1 : MAX_PARALLEL_TANKS;
    for (let n = 1; n <= splits && placed.length === 0; n++) {
      const free = pool
        .map((tank) => ({ tank, start: earliestFree(tank, days[stage], from, entries, stageVolume / n) }))
        .filter((c): c is { tank: SlotTank; start: Date } => c.start !== null)
        .sort((a, b) => a.start.getTime() - b.start.getTime());
      if (free.length >= n) {
        // Parallel tanks fill together: all start when the last of them is free.
        const shared = free[n - 1].start;
        placed = free.slice(0, n).map((c) => ({ tank: c.tank, start: shared }));
      }
    }

    if (placed.length === 0) {
      const biggest = pool.reduce((m, t) => Math.max(m, t.capacity_bbl ?? 0), 0);
      const tooBig = biggest > 0 && stageVolume > biggest * splits;
      return {
        feasible: false,
        reason: tooBig
          ? `${stageVolume.toFixed(1)} bbl does not fit: the largest ${STAGE_LABEL[stage]} holds ${biggest} bbl${splits > 1 ? ` (${biggest * splits} across ${splits})` : ""}. Reduce the turns.`
          : `No ${STAGE_LABEL[stage]} is free in the next year.`,
        sequence: [],
      };
    }

    const start = placed[0].start;
    if (stage === "brewhouse") brewDay = start;
    for (const p of placed) {
      sequence.push({
        stage,
        equipment_id: p.tank.id,
        equipment_name: p.tank.name,
        scheduled_start: iso(start),
        scheduled_end: iso(addDays(start, days[stage])),
        volume_bbl: Math.round((stageVolume / placed.length) * 100) / 100,
      });
    }
    stageStart = addDays(start, days[stage]);
  }

  return { feasible: true, reason: null, sequence };
}
