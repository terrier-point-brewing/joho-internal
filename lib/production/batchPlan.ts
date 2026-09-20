// lib/production/batchPlan.ts
//
// The tank bookings and allocations that ride along with a new batch.
//
// Intake used to save a batch in three separate client calls (batch → tanks →
// allocations). A failure mid-way left a half-built batch, and retrying made a
// duplicate. Now the whole plan goes to POST /api/production/batches, which
// checks it HERE before anything is written and removes the batch if a later
// write still fails.

export const SCHEDULE_STAGES = ["brewhouse", "fermenting", "conditioning"] as const;
export type ScheduleStage = (typeof SCHEDULE_STAGES)[number];

/** Intake's tank-type words → the stage names Brewing's schedule reads. */
const STAGE_ALIASES: Record<string, ScheduleStage> = {
  brewhouse: "brewhouse",
  fermenter: "fermenting",
  fermenting: "fermenting",
  brite: "conditioning",
  conditioning: "conditioning",
};

export function normalizeStage(stage: string): ScheduleStage | null {
  return STAGE_ALIASES[stage] ?? null;
}

export const ALLOCATION_CHANNELS = ["taproom", "distribution", "contract_brewing", "wholesale", "safety_stock"] as const;

export interface PlanSlotInput {
  stage: string;
  equipment_id: string;
  /** ISO dates (YYYY-MM-DD). */
  planned_start: string;
  planned_end: string;
  volume_bbl?: number | null;
}

export interface PlanAllocationInput {
  channel: string;
  percentage: number;
  partner_id?: string | null;
  contract_request_id?: string | null;
  notes?: string | null;
}

export interface BusyEntry {
  equipment_id: string | null;
  start: string;
  end: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Noon, not midnight: a date-only booking must not slide a day across time zones. */
export function slotTimestamp(date: string): string {
  return `${date}T12:00:00`;
}

/** First problem with the plan in plain words, or null when it can be saved. */
export function validateBatchPlan(input: {
  schedule: PlanSlotInput[];
  allocations: PlanAllocationInput[];
  commitmentChannelById: Map<string, string | null>;
  busy: BusyEntry[];
  tankNameById?: Map<string, string>;
}): string | null {
  const { schedule, allocations, commitmentChannelById, busy, tankNameById } = input;

  for (const s of schedule) {
    if (!normalizeStage(s.stage)) return `Unknown schedule stage "${s.stage}".`;
    if (!s.equipment_id) return `Pick a tank for every ${s.stage} slot.`;
    if (!DATE_RE.test(s.planned_start) || !DATE_RE.test(s.planned_end)) return `The ${s.stage} slot needs a start and an end date.`;
    if (s.planned_end < s.planned_start) return `The ${s.stage} slot ends before it starts.`;
    const start = new Date(slotTimestamp(s.planned_start)).getTime();
    const end = new Date(slotTimestamp(s.planned_end)).getTime();
    const clash = busy.find((b) =>
      b.equipment_id === s.equipment_id
      && start < new Date(b.end).getTime()
      && end > new Date(b.start).getTime());
    if (clash) return `${tankNameById?.get(s.equipment_id) ?? "A tank"} is already booked during the ${s.stage} slot.`;
  }

  let total = 0;
  for (const a of allocations) {
    if (!(ALLOCATION_CHANNELS as readonly string[]).includes(a.channel)) return `Invalid allocation channel "${a.channel}".`;
    const pct = Number(a.percentage);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return "Each allocation needs a percentage between 0 and 100.";
    total += pct;
    if (a.contract_request_id) {
      if (!commitmentChannelById.has(a.contract_request_id)) return "A linked commitment does not exist.";
      const ch = commitmentChannelById.get(a.contract_request_id);
      if (ch && ch !== a.channel) return `A linked commitment is ${ch} — its allocation must use the same channel.`;
    } else if (a.channel !== "taproom" && a.channel !== "safety_stock") {
      return `Pick the commitment for the ${a.channel.replace("_", " ")} allocation, or remove the row.`;
    }
  }
  if (total > 100 + 1e-6) return `Allocations add up to ${total.toFixed(1)}% — they cannot exceed 100%.`;

  return null;
}
