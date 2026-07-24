import type { ScheduleEntry } from "../../hooks/queries";
import type { BatchConversion } from "../../types";

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

// Equipment types that may be used for a given stage. Conditioning accepts
// brite tanks as well as fermenters (a fermenter can double as a brite).
export const STAGE_TO_EQ_TYPES: Record<string, string[]> = {
  brewhouse:    ["brewhouse"],
  fermenter:    ["fermenter"],
  fermenting:   ["fermenter"],
  conditioning: ["brite", "fermenter"],
  kegging:      ["kegging"],
  canning:      ["canning"],
};

// Stages available for manual schedule entry (no cold_storage)
export const PLANNING_STAGES = ["brewhouse", "fermenting", "conditioning", "kegging", "canning"] as const;
export type PlanningStage = typeof PLANNING_STAGES[number];

// Per-stage card chrome for the equipment-schedule flow. Binds to the
// theme-flipping `--cat-{hue}-*` tokens (border/bg/label) so cards read on the
// dark ops canvas AND the light brand skin; `activeBorder` stays a raw `-500`
// mid-tone that reads on either background. cold_storage uses neutral semantic
// tokens, which flip on their own.
export const STAGE_CARD_STYLE: Record<string, {
  border: string; activeBorder: string; bg: string; label: string;
}> = {
  brewhouse:    { border: "border-[var(--cat-amber-bd)]",  activeBorder: "border-amber-500",  bg: "bg-[var(--cat-amber-bg)]",  label: "text-[var(--cat-amber-fg)]"  },
  fermenting:   { border: "border-[var(--cat-blue-bd)]",   activeBorder: "border-blue-500",   bg: "bg-[var(--cat-blue-bg)]",   label: "text-[var(--cat-blue-fg)]"   },
  conditioning: { border: "border-[var(--cat-teal-bd)]",   activeBorder: "border-teal-500",   bg: "bg-[var(--cat-teal-bg)]",   label: "text-[var(--cat-teal-fg)]"   },
  kegging:      { border: "border-[var(--cat-purple-bd)]", activeBorder: "border-purple-500", bg: "bg-[var(--cat-purple-bg)]", label: "text-[var(--cat-purple-fg)]" },
  canning:      { border: "border-[var(--cat-violet-bd)]", activeBorder: "border-violet-500", bg: "bg-[var(--cat-violet-bg)]", label: "text-[var(--cat-violet-fg)]" },
  cold_storage: { border: "border-line-strong",            activeBorder: "border-line-subtle", bg: "bg-surface-mid",           label: "text-secondary"              },
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
  brewhouse: "bg-[var(--cat-amber-bg)] text-[var(--cat-amber-fg)] border-[var(--cat-amber-bd)]",
  fermenter: "bg-[var(--cat-blue-bg)] text-[var(--cat-blue-fg)] border-[var(--cat-blue-bd)]",
  brite:     "bg-[var(--cat-teal-bg)] text-[var(--cat-teal-fg)] border-[var(--cat-teal-bd)]",
  kegging:   "bg-[var(--cat-purple-bg)] text-[var(--cat-purple-fg)] border-[var(--cat-purple-bd)]",
  canning:   "bg-[var(--cat-violet-bg)] text-[var(--cat-violet-fg)] border-[var(--cat-violet-bd)]",
};

export const PIPELINE: { slot: BuildSlot["stage"]; dbStage: string }[] = [
  { slot: "brewhouse", dbStage: "brewhouse"    },
  { slot: "fermenter", dbStage: "fermenting"   },
  { slot: "brite",     dbStage: "conditioning" },
];
// Canning is listed before Kegging so it's offered/added first when both are missing.
export const OPTIONAL_PIPELINE: { slot: BuildSlot["stage"]; dbStage: string; label: string }[] = [
  { slot: "canning", dbStage: "canning", label: "+ Add Canning" },
  { slot: "kegging", dbStage: "kegging", label: "+ Add Kegging" },
];

export const EQ_TYPE_FOR_SLOT: Record<BuildSlot["stage"], string> = {
  brewhouse: "brewhouse", fermenter: "fermenter", brite: "brite",
  kegging: "kegging", canning: "canning",
};

// Equipment types accepted per build slot — brite accepts fermenters too.
export const EQ_TYPES_FOR_SLOT: Record<BuildSlot["stage"], string[]> = {
  brewhouse: ["brewhouse"], fermenter: ["fermenter"], brite: ["brite", "fermenter"],
  kegging: ["kegging"], canning: ["canning"],
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

// Per-branch packaging completeness: required quantity for a branch is the
// BBL recorded on that branch's Conditioning stage entry. "Incomplete" means
// kegging+canning scheduled for that branch don't yet add up to that volume.
export type BranchPackagingStatus = {
  branch: string | null;
  label: string;
  condBbl: number;
  pkgBbl: number;
  pendingPkgBbl: number;    // packaging entries not yet completed (actual_end == null)
  remainingCondBbl: number; // conditioning volume not yet covered by completed packaging
  status: "ok" | "incomplete" | "over" | "no_packaging" | "no_planned_for_remaining";
};

export function computeBranchPackagingStatus(
  entries: ScheduleEntry[],
  batch?: { id: string },
  allTransfers: {
    batch_id: string;
    from_tank_id: string | null;
    volume_bbl: number;
    shrinkage_bbl?: number;
    transfer_type?: string;
  }[] = [],
  batchConversions: BatchConversion[] = [],
): BranchPackagingStatus[] {
  const active = entries.filter(e => !e.cancelled_at);
  const branches = [null, ...new Set(active.filter(e => e.planned_branch).map(e => e.planned_branch!))] as (string | null)[];

  return branches.flatMap(branch => {
    const bEntries = active.filter(e => branch === null ? !e.planned_branch : e.planned_branch === branch);
    const cond = bEntries.find(e => e.stage === "conditioning");
    // No conditioning entry at all — the outer scheduleMissing check handles this case.
    if (!cond) return [];
    // If conditioning is still receiving (open) and the upstream fermenter
    // hasn't fully drained yet, the rest of that volume is still expected —
    // compare packaging against the eventual total, not just what's landed
    // in conditioning so far.
    let condBbl = Number(cond.volume_bbl ?? 0);
    if (cond.actual_end == null && cond.equipment_id && batch) {
      const ferment = bEntries.find(e => (e.stage === "fermenting" || e.stage === "fermenter") && e.equipment_id && e.actual_end == null);
      if (ferment?.equipment_id) {
        const departedFromFerment = allTransfers
          .filter(t => t.batch_id === batch.id && t.from_tank_id === ferment.equipment_id)
          .reduce((s, t) => s + Number(t.volume_bbl), 0);
        // A pending conversion out of this same tank is a legitimate sink,
        // not volume still headed to conditioning — net it out so it isn't
        // double-counted as "still expected".
        const plannedConversionAway = batchConversions
          .filter(c => c.source_batch_id === batch?.id && c.source_equipment_id === ferment.equipment_id && !c.converted_at)
          .reduce((s, c) => s + Number(c.volume_bbl), 0);
        const fermentArrivedTotal = Number(ferment.volume_bbl ?? 0) + departedFromFerment - plannedConversionAway;
        condBbl = Math.max(condBbl, fermentArrivedTotal);
      }
    }
    // Net out any pending batch_conversions that pull volume directly from this
    // conditioning tank. Those BBL are a legitimate downstream sink — they aren't
    // expected to be packaged, so they should not inflate the required packaging
    // target. Applies when fermenting is already closed and condBbl therefore
    // reflects "currently remaining in tank" rather than the original arrived total.
    const pendingConversionFromCond =
      cond.equipment_id && batch
        ? batchConversions
            .filter(c => c.source_batch_id === batch.id && c.source_equipment_id === cond.equipment_id && !c.converted_at)
            .reduce((s, c) => s + Number(c.volume_bbl), 0)
        : 0;
    const effectiveCondBbl = Math.max(0, condBbl - pendingConversionFromCond);

    const pkgEntries = bEntries.filter(e => e.stage === "kegging" || e.stage === "canning");
    const completedPkgBbl = pkgEntries
      .filter(e => e.actual_end != null)
      .reduce((s, e) => s + Number(e.volume_bbl ?? 0), 0);
    const pendingPkgBbl = pkgEntries
      .filter(e => e.actual_end == null)
      .reduce((s, e) => s + Number(e.volume_bbl ?? 0), 0);
    const pkgBbl = completedPkgBbl + pendingPkgBbl;
    const pkgShrinkage = batch
      ? allTransfers
          .filter(t =>
            t.batch_id === batch.id &&
            (t.transfer_type === "kegging" || t.transfer_type === "canning"),
          )
          .reduce((s, t) => s + Number(t.shrinkage_bbl ?? 0), 0)
      : 0;
    const effectivePkgBbl = pkgBbl + pkgShrinkage;
    // When conditioning is open and volume_bbl was NOT inflated by a still-draining
    // fermenter, it represents the current remaining balance — completed packaging has
    // already departed, so only subtract pending (future) runs to find what's unplanned.
    // Otherwise (closed conditioning or ferment-inflated condBbl = full expected total),
    // subtract all completed packaging and shrinkage.
    const fermentInflated = condBbl > Number(cond.volume_bbl ?? 0);
    const remainingCondBbl = (cond.actual_end == null && !fermentInflated)
      ? Math.max(0, effectiveCondBbl - pendingPkgBbl)
      : Math.max(0, effectiveCondBbl - completedPkgBbl - pkgShrinkage);
    const hasPkg = pkgEntries.length > 0;
    const label = branch ?? "Main";
    let status: BranchPackagingStatus["status"] = "ok";
    // All remaining conditioning volume is committed to a pending conversion —
    // no packaging required; whatever was already packaged is fine.
    if (effectiveCondBbl <= 0 && pendingConversionFromCond > 0.001) status = "ok";
    else if (!hasPkg) status = "no_packaging";
    else if (condBbl <= 0) status = "incomplete";  // conditioning has no volume — can't verify
    // Completed packaging runs left remaining volume with no planned runs to cover it.
    else if (remainingCondBbl > 0.01 && pendingPkgBbl < 0.01) status = "no_planned_for_remaining";
    else if (effectivePkgBbl < effectiveCondBbl - 0.01) status = "incomplete";
    else if (effectivePkgBbl > effectiveCondBbl + 0.01) status = "over";
    return [{ branch, label, condBbl, pkgBbl, pendingPkgBbl, remainingCondBbl, status }];
  });
}

// ── Live equipment-conflict detection ───────────────────────────────────────
// Used both at save-time and live (as soon as equipment + dates are chosen) so
// the user doesn't have to wait for a save attempt to discover a clash.
export function findEquipmentConflict(
  allEntries: ScheduleEntry[],
  equipmentId: string,
  start: string, // YYYY-MM-DD
  end: string,   // YYYY-MM-DD
  batchId: string,
  excludeEntryId?: string,
): ScheduleEntry | null {
  if (!equipmentId || !start || !end) return null;
  return allEntries.find(e =>
    e.id !== excludeEntryId &&
    e.batch_id !== batchId &&
    e.equipment_id === equipmentId &&
    !e.cancelled_at &&
    e.planned_start.slice(0, 10) < end &&
    e.planned_end.slice(0, 10) > start
  ) ?? null;
}

export function conflictBatchLabel(conflict: ScheduleEntry): string {
  return conflict.brew_batches
    ? `#${conflict.brew_batches.batch_number} ${conflict.brew_batches.beer_name}`
    : "another batch";
}

// First piece of equipment in `pool` (sorted by name) with no conflict for the
// given date range — used to suggest an alternative when the chosen one clashes.
export function suggestAlternativeEquipment<T extends { id: string; name: string }>(
  pool: T[],
  allEntries: ScheduleEntry[],
  start: string,
  end: string,
  batchId: string,
  excludeEquipmentId?: string,
  excludeEntryId?: string,
): T | null {
  if (!start || !end) return null;
  const sorted = [...pool].sort((a, b) => a.name.localeCompare(b.name));
  for (const eq of sorted) {
    if (eq.id === excludeEquipmentId) continue;
    if (!findEquipmentConflict(allEntries, eq.id, start, end, batchId, excludeEntryId)) return eq;
  }
  return null;
}

export function nextRequiredStageAfter(stage: string): { dbStage: string; label: string } | null {
  const norm = stage === "fermenter" ? "fermenting" : stage;
  const idx = REQUIRED_PIPELINE.findIndex(s => s.dbStage === norm);
  return (idx >= 0 && idx < REQUIRED_PIPELINE.length - 1) ? REQUIRED_PIPELINE[idx + 1] : null;
}
