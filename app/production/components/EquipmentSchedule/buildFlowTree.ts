import type { ScheduleEntry } from "../../hooks/queries";
import type { BrewBatch, BatchTransfer } from "../../types";
import type { FlowItem, PackagingTrack } from "./types";
import { REQUIRED_PIPELINE, nextRequiredStageAfter } from "./constants";

export function buildFlowTree(
  entries: ScheduleEntry[],   // ALL active entries — main flow + split branches
  batchTransfers: BatchTransfer[],
  allTransfers: BatchTransfer[],
  allBatches: BrewBatch[],
  batch?: BrewBatch,
): FlowItem | null {
  const active = entries.filter(e => !e.cancelled_at);

  const mainEntries    = active.filter(e => !e.planned_branch);
  const branchNames    = [...new Set(active.filter(e => e.planned_branch).map(e => e.planned_branch!))].sort();
  const branchEntriesFor = (name: string) => active.filter(e => e.planned_branch === name);

  const plannedConvEntries   = mainEntries.filter(e => e.stage === "planned_conversion");
  const mainPkgEntries       = mainEntries.filter(e => e.stage === "kegging" || e.stage === "canning");
  const mainNonPkgEntries    = mainEntries.filter(
    e => e.stage !== "kegging" && e.stage !== "canning" && e.stage !== "planned_conversion"
  );

  const entryByTank = new Map<string, ScheduleEntry>();
  for (const e of mainNonPkgEntries) {
    if (e.equipment_id) entryByTank.set(e.equipment_id, e);
  }

  const childTanks = new Map<string, Set<string>>();
  for (const t of batchTransfers) {
    if (t.from_tank_id && t.to_tank_id) {
      if (!childTanks.has(t.from_tank_id)) childTanks.set(t.from_tank_id, new Set());
      childTanks.get(t.from_tank_id)!.add(t.to_tank_id);
    }
  }

  const convsByTank = new Map<string, Array<{ toBatch: BrewBatch; volumeBbl: number }>>();
  for (const cb of allBatches.filter(b => b.converted_from_batch_id === batch?.id)) {
    const sourceTx = allTransfers
      .filter(t => t.batch_id === batch?.id && t.transfer_type === "conversion" && t.to_batch_id === cb.id)
      .sort((a, b) => new Date(a.transferred_at).getTime() - new Date(b.transferred_at).getTime())[0];
    if (sourceTx?.from_tank_id) {
      const src = sourceTx.from_tank_id;
      if (!convsByTank.has(src)) convsByTank.set(src, []);
      convsByTank.get(src)!.push({ toBatch: cb, volumeBbl: Number(sourceTx.volume_bbl) });
    }
  }

  const tanksWithInflow = new Set(batchTransfers.filter(t => t.to_tank_id).map(t => t.to_tank_id!));
  const rootEntry = mainNonPkgEntries.find(e => e.stage === "brewhouse")
    ?? mainNonPkgEntries.find(e => e.equipment_id && !tanksWithInflow.has(e.equipment_id))
    ?? mainNonPkgEntries[0];
  if (!rootEntry) return null;

  const visitedIds = new Set<string>();

  // Build the packaging_group node (conditioning column + packaging box for all tracks).
  function buildPackagingGroup(mainCondEntry?: ScheduleEntry): FlowItem {
    const tracks: PackagingTrack[] = [];

    const mainCondItem: FlowItem = mainCondEntry
      ? { kind: "entry", entry: mainCondEntry, children: [] }
      : { kind: "ghost", stage: "conditioning", label: "Conditioning", isRequired: true, children: [] };

    const mainKeg = mainPkgEntries.filter(e => e.stage === "kegging");
    const mainCan = mainPkgEntries.filter(e => e.stage === "canning");
    const mainItems: FlowItem[] = [
      ...mainKeg.map(e => ({ kind: "entry" as const, entry: e, children: [] as FlowItem[] })),
      ...mainCan.map(e => ({ kind: "entry" as const, entry: e, children: [] as FlowItem[] })),
    ].sort((a, b) => (a.entry.planned_start ?? "").localeCompare(b.entry.planned_start ?? ""));
    if (!mainKeg.length) mainItems.push({ kind: "ghost", stage: "kegging", label: "Kegging", isRequired: false, children: [] });
    if (!mainCan.length) mainItems.push({ kind: "ghost", stage: "canning", label: "Canning", isRequired: false, children: [] });

    tracks.push({ conditioning: mainCondItem, items: mainItems });

    for (const name of branchNames) {
      const bEnts = branchEntriesFor(name);
      const branchCond = bEnts.find(e => e.stage === "conditioning");
      const branchCondItem: FlowItem = branchCond
        ? { kind: "entry", entry: branchCond, children: [] }
        : { kind: "ghost", stage: "conditioning", label: "Conditioning", isRequired: false, children: [] };

      const bKeg = bEnts.filter(e => e.stage === "kegging");
      const bCan = bEnts.filter(e => e.stage === "canning");
      const bItems: FlowItem[] = [
        ...bKeg.map(e => ({ kind: "entry" as const, entry: e, children: [] as FlowItem[] })),
        ...bCan.map(e => ({ kind: "entry" as const, entry: e, children: [] as FlowItem[] })),
      ].sort((a, b) => (a.entry.planned_start ?? "").localeCompare(b.entry.planned_start ?? ""));
      if (!bKeg.length) bItems.push({ kind: "ghost", stage: "kegging", label: "Kegging", isRequired: false, children: [] });
      if (!bCan.length) bItems.push({ kind: "ghost", stage: "canning", label: "Canning", isRequired: false, children: [] });

      tracks.push({ conditioning: branchCondItem, items: bItems });
    }

    return { kind: "packaging_group", tracks, children: [] };
  }

  function buildNode(entry: ScheduleEntry): FlowItem {
    visitedIds.add(entry.id);
    const tankId = entry.equipment_id ?? "";
    const norm   = entry.stage === "fermenter" ? "fermenting" : entry.stage;
    const children: FlowItem[] = [];

    // Transfer-graph children. Conditioning is intercepted → packaging_group.
    for (const childTankId of childTanks.get(tankId) ?? []) {
      const childEntry = entryByTank.get(childTankId);
      if (!childEntry || visitedIds.has(childEntry.id)) continue;
      const childNorm = childEntry.stage === "fermenter" ? "fermenting" : childEntry.stage;
      if (childNorm === "conditioning") {
        if (!children.some(c => c.kind === "packaging_group")) {
          visitedIds.add(childEntry.id);
          children.push(buildPackagingGroup(childEntry));
        }
      } else {
        children.push(buildNode(childEntry));
      }
    }

    // Conversions
    for (const conv of convsByTank.get(tankId) ?? []) {
      children.push({ kind: "conversion", toBatch: conv.toBatch, volumeBbl: conv.volumeBbl, children: [] });
    }
    for (const pce of plannedConvEntries.filter(e => e.equipment_id === tankId)) {
      let beerName = "Unknown batch";
      const vol = Number(pce.volume_bbl ?? 0);
      try { const p = JSON.parse(pce.notes ?? "{}"); if (p.beer_name) beerName = p.beer_name; }
      catch { if (pce.notes) beerName = pce.notes; }
      children.push({ kind: "planned_conversion", beerName, volumeBbl: vol, children: [] });
    }

    // Ghost / stage-matching fallback when no transfer children exist
    if (children.length === 0 && !entry.actual_end) {
      const next = nextRequiredStageAfter(norm);
      if (next) {
        if (next.dbStage === "conditioning") {
          const nextEntry = mainNonPkgEntries.find(e => e.stage === "conditioning" && !visitedIds.has(e.id));
          if (nextEntry) visitedIds.add(nextEntry.id);
          children.push(buildPackagingGroup(nextEntry));
        } else {
          const nextEntry = mainNonPkgEntries.find(e => e.stage === next.dbStage && !visitedIds.has(e.id));
          if (nextEntry) {
            children.push(buildNode(nextEntry));
          } else {
            children.push({ kind: "ghost", stage: next.dbStage, label: next.label, isRequired: true, children: [] });
          }
        }
      }
    }

    return { kind: "entry", entry, children };
  }

  return buildNode(rootEntry);
}
