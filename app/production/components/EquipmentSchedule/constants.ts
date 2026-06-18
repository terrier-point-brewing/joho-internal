import type { ScheduleEntry } from "../../hooks/queries";

export const STAGE_LABELS: Record<string, string> = {
  brewhouse:    "Brewing",
  fermenter:    "Fermenting",
  fermenting:   "Fermenting",
  conditioning: "Conditioning",
  kegging:      "Kegging",
  canning:      "Canning",
};

export const STAGE_TO_EQ_TYPE: Record<string, string> = {
  brewhouse:    "brewhouse",
  fermenter:    "fermenter",
  fermenting:   "fermenter",
  conditioning: "brite",
  kegging:      "kegging",
  canning:      "canning",
};

// Stages available for manual schedule entry (no cold_storage)
export const PLANNING_STAGES = ["brewhouse", "fermenting", "conditioning", "kegging", "canning"] as const;
export type PlanningStage = typeof PLANNING_STAGES[number];

export const STAGE_CARD_STYLE: Record<string, {
  border: string; activeBorder: string; bg: string; label: string;
}> = {
  brewhouse:    { border: "border-amber-700/50",  activeBorder: "border-amber-500",  bg: "bg-amber-950/30",  label: "text-amber-400"  },
  fermenting:   { border: "border-blue-700/50",   activeBorder: "border-blue-500",   bg: "bg-blue-950/30",   label: "text-blue-400"   },
  conditioning: { border: "border-teal-700/50",   activeBorder: "border-teal-500",   bg: "bg-teal-950/30",   label: "text-teal-400"   },
  kegging:      { border: "border-purple-700/50", activeBorder: "border-purple-500", bg: "bg-purple-950/30", label: "text-purple-400" },
  canning:      { border: "border-violet-700/50", activeBorder: "border-violet-500", bg: "bg-violet-950/30", label: "text-violet-400" },
  cold_storage: { border: "border-zinc-600/50",   activeBorder: "border-zinc-400",   bg: "bg-zinc-900/50",   label: "text-zinc-400"   },
};

// Ordered pipeline for flow and scheduling
export const REQUIRED_PIPELINE: { dbStage: string; label: string }[] = [
  { dbStage: "brewhouse",    label: "Brewing" },
  { dbStage: "fermenting",   label: "Fermenting" },
  { dbStage: "conditioning", label: "Conditioning" },
];

export const PACKAGING_PIPELINE: { dbStage: string; label: string }[] = [
  { dbStage: "kegging", label: "Kegging" },
  { dbStage: "canning", label: "Canning" },
];

// For BuildSchedulePanel
export type BuildSlot = {
  stage: "brewhouse" | "fermenter" | "brite" | "kegging" | "canning";
  equipment_id: string;
  scheduled_start: string;
  scheduled_end: string;
  volume_bbl?: string;
};

export const BUILD_STAGE_LABELS: Record<BuildSlot["stage"], string> = {
  brewhouse: "Brewing",
  fermenter: "Fermenting",
  brite:     "Conditioning",
  kegging:   "Kegging",
  canning:   "Canning",
};

export const BUILD_STAGE_COLORS: Record<string, string> = {
  brewhouse: "bg-amber-900/50 text-amber-300 border-amber-700",
  fermenter:  "bg-blue-900/50 text-blue-300 border-blue-700",
  brite:      "bg-teal-900/50 text-teal-300 border-teal-700",
  kegging:    "bg-purple-900/50 text-purple-300 border-purple-700",
  canning:    "bg-violet-900/50 text-violet-300 border-violet-700",
};

export const PIPELINE: { slot: BuildSlot["stage"]; dbStage: string }[] = [
  { slot: "brewhouse", dbStage: "brewhouse"    },
  { slot: "fermenter", dbStage: "fermenting"   },
  { slot: "brite",     dbStage: "conditioning" },
];
export const OPTIONAL_PIPELINE: { slot: BuildSlot["stage"]; dbStage: string; label: string }[] = [
  { slot: "kegging", dbStage: "kegging", label: "+ Add Kegging" },
  { slot: "canning", dbStage: "canning", label: "+ Add Canning" },
];

export const EQ_TYPE_FOR_SLOT: Record<BuildSlot["stage"], string> = {
  brewhouse: "brewhouse", fermenter: "fermenter", brite: "brite",
  kegging: "kegging", canning: "canning",
};

// Stages after which a split makes sense
export const SPLITTABLE_STAGES = new Set(["brewhouse", "fermenting", "conditioning"]);
export const CONVERTIBLE_STAGES = new Set(["fermenting", "conditioning"]);

export function stageDuration(entry: ScheduleEntry): number {
  const s = (entry.actual_start ?? entry.planned_start).slice(0, 10);
  const e = (entry.actual_end   ?? entry.planned_end).slice(0, 10);
  return Math.max(1, Math.round(
    (new Date(e + "T12:00:00").getTime() - new Date(s + "T12:00:00").getTime()) / 86400000
  ));
}

export function fmtShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso.slice(0, 10) + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function nextRequiredStageAfter(stage: string): { dbStage: string; label: string } | null {
  const norm = stage === "fermenter" ? "fermenting" : stage;
  const idx = REQUIRED_PIPELINE.findIndex(s => s.dbStage === norm);
  return (idx >= 0 && idx < REQUIRED_PIPELINE.length - 1) ? REQUIRED_PIPELINE[idx + 1] : null;
}
