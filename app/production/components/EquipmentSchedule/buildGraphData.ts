import { type Node, type Edge, MarkerType, Position } from "@xyflow/react";
import type { ScheduleEntry } from "../../hooks/queries";
import type { BrewBatch, BatchTransfer } from "../../types";
import { STAGE_LABELS } from "./constants";

const COL_STEP = 240;  // px between stage columns
const ROW_STEP = 150;  // px between tracks (split branches)

// Fixed column for each pipeline stage
const STAGE_COL: Record<string, number> = {
  brewhouse:    0,
  fermenting:   1,
  conditioning: 2,
  // packaging: 3+ sequential by planned_start order within the track
};

// Required pipeline stages (main track vs split track)
const MAIN_PIPELINE  = ["brewhouse", "fermenting", "conditioning"];
const SPLIT_PIPELINE = ["conditioning"];  // splits create their own conditioning downstream

const EDGE_DEFAULTS = {
  type: "smoothstep",
  markerEnd: { type: MarkerType.ArrowClosed, color: "#52525b", width: 14, height: 14 },
  style: { strokeDasharray: "5 4", stroke: "#52525b", strokeWidth: 1.5 },
} as const;

function normStage(s: string) {
  return s === "fermenter" ? "fermenting" : s;
}

// While a tank is open (actual_end null) it may be mid partial-drain, in which
// case its volume_bbl has been overwritten to "currently remaining" (see
// transfers/route.ts's partial-transfer reassignment block) rather than the
// original total that arrived there. Reconstruct the true arrived total from
// the transfer ledger in that case.
function arrivedVolume(
  entry: ScheduleEntry | undefined,
  batch: BrewBatch | undefined,
  allTransfers: BatchTransfer[],
): number {
  if (!entry?.volume_bbl) return 0;
  let vol = Number(entry.volume_bbl);
  if (entry.actual_end == null && entry.equipment_id && batch) {
    const departedTotal = allTransfers
      .filter(t => t.batch_id === batch.id && t.from_tank_id === entry.equipment_id)
      .reduce((sum, t) => sum + Number(t.volume_bbl), 0);
    if (departedTotal > 0) vol += departedTotal;
  }
  return vol;
}

// Detail for an entry node whose tank is mid partial-drain: the full amount
// that arrived, vs. how much has already departed onward, so the node can
// show "11/36 bbl remaining" instead of just the bare 11.
function partialDrainInfo(
  entry: ScheduleEntry,
  batch: BrewBatch | undefined,
  allTransfers: BatchTransfer[],
): { arrived: number; departed: number } | null {
  if (entry.actual_end != null || !entry.equipment_id || !batch) return null;
  const departed = allTransfers
    .filter(t => t.batch_id === batch.id && t.from_tank_id === entry.equipment_id)
    .reduce((sum, t) => sum + Number(t.volume_bbl), 0);
  if (departed <= 0) return null;
  return { arrived: Number(entry.volume_bbl) + departed, departed };
}

// Determine which main-pipeline stage a split branched OFF FROM.
// e.g. if branch's first entry is "conditioning", the origin is "fermenting".
function splitOriginStage(firstBranchStage: string): string | null {
  const idx = MAIN_PIPELINE.indexOf(firstBranchStage);
  return idx > 0 ? MAIN_PIPELINE[idx - 1] : null;
}

export function buildGraphData(
  entries: ScheduleEntry[],
  allBatches: BrewBatch[],
  batch: BrewBatch | undefined,
  allTransfers: BatchTransfer[],
  allScheduleEntries: ScheduleEntry[] = entries,
): { nodes: Node[]; edges: Edge[] } {
  const active       = entries.filter(e => !e.cancelled_at);
  const mainEntries  = active.filter(e => !e.planned_branch);
  const branchNames  = [...new Set(
    active.filter(e => e.planned_branch).map(e => e.planned_branch!),
  )].sort();

  const allNodes: Node[] = [];
  const allEdges: Edge[] = [];

  // node-id lookup by normalised stage — populated while building the main track
  // so split-branch fork edges can reference the correct origin node.
  const mainNodeIdByStage = new Map<string, string>();

  function addEdge(source: string, target: string) {
    allEdges.push({ id: `${source}->${target}`, source, target, ...EDGE_DEFAULTS });
  }

  function addNode(id: string, type: string, col: number, row: number, data: Record<string, unknown>) {
    allNodes.push({
      id,
      type,
      position: { x: col * COL_STEP, y: row * ROW_STEP },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data,
    });
  }

  // Terminal node id of each track (main = null key), used to anchor conversion
  // fork edges when the converting entry itself can't be found.
  const trackEndNodeId = new Map<string | null, string>();

  // Per-branch: which main-pipeline stage it forked from, which stage it starts
  // at, and the volume booked there — used to aggregate shrinkage across splits.
  const branchStartInfo: { originStage: string | null; startStage: string; volume: number }[] = [];

  // ── Build a single track ──────────────────────────────────────────────────
  function buildTrack(
    trackEntries: ScheduleEntry[],
    branch: string | null,
    row: number,
  ) {
    const norm        = normStage;
    const PKG_ORDER: Record<string, number> = { kegging: 0, canning: 1 };
    const pkgEntries  = trackEntries
      .filter(e => e.stage === "kegging" || e.stage === "canning")
      .sort((a, b) => {
        const dateCmp = (a.planned_start ?? "").localeCompare(b.planned_start ?? "");
        return dateCmp !== 0 ? dateCmp : (PKG_ORDER[a.stage] ?? 0) - (PKG_ORDER[b.stage] ?? 0);
      });
    const nonPkgMap   = new Map(
      trackEntries
        .filter(e => e.stage !== "kegging" && e.stage !== "canning" && e.stage !== "planned_conversion")
        .map(e => [norm(e.stage), e]),
    );

    let prevId: string | null = null;

    const connect = (targetId: string) => {
      if (prevId) addEdge(prevId, targetId);
      prevId = targetId;
    };

    // ── Non-packaging stages ──────────────────────────────────────────────
    if (branch === null) {
      // Main track: fill in the full pipeline, adding ghosts for missing stages.
      // A batch created from a conversion never has upstream (brewhouse/fermenting)
      // stages — it starts directly at conditioning, in the receiving tank.
      const pipelineForThisBatch = batch?.converted_from_batch_id
        ? MAIN_PIPELINE.filter(s => s === "conditioning")
        : MAIN_PIPELINE;
      for (const stage of pipelineForThisBatch) {
        const entry = nonPkgMap.get(stage);
        const col   = STAGE_COL[stage];
        if (entry) {
          addNode(entry.id, "entryNode", col, row, { entry, partialDrain: partialDrainInfo(entry, batch, allTransfers) });
          mainNodeIdByStage.set(stage, entry.id);
          connect(entry.id);
        } else {
          const ghostId = `ghost-${stage}-main`;
          addNode(ghostId, "ghostNode", col, row, { stage, label: STAGE_LABELS[stage] ?? stage, isRequired: true });
          mainNodeIdByStage.set(stage, ghostId);
          connect(ghostId);
        }
      }
    } else {
      // Split track: determine which stage the branch starts at, then build forward
      const firstExistingStage = ["brewhouse", "fermenting", "conditioning"]
        .find(s => nonPkgMap.has(s) || (pkgEntries.length > 0 && s === "conditioning"));
      const startStage = firstExistingStage ?? "conditioning";

      // Fork edge: from the main track node at the stage BEFORE startStage
      const originStage = splitOriginStage(startStage);
      if (originStage) {
        const originId = mainNodeIdByStage.get(originStage);
        if (originId) prevId = originId;
      }
      branchStartInfo.push({
        originStage,
        startStage,
        volume: Number(nonPkgMap.get(startStage)?.volume_bbl ?? 0),
      });

      // Stages from startStage forward
      const branchPipeline = MAIN_PIPELINE.slice(MAIN_PIPELINE.indexOf(startStage));
      for (const stage of branchPipeline) {
        const entry = nonPkgMap.get(stage);
        const col   = STAGE_COL[stage];
        if (entry) {
          addNode(entry.id, "entryNode", col, row, { entry, partialDrain: partialDrainInfo(entry, batch, allTransfers) });
          connect(entry.id);
        } else {
          const ghostId = `ghost-${stage}-${branch}`;
          addNode(ghostId, "ghostNode", col, row, { stage, label: STAGE_LABELS[stage] ?? stage, isRequired: false });
          connect(ghostId);
        }
      }
    }

    // ── Packaging ─────────────────────────────────────────────────────────
    const hasKeg = pkgEntries.some(e => e.stage === "kegging");
    const hasCan = pkgEntries.some(e => e.stage === "canning");

    for (let i = 0; i < pkgEntries.length; i++) {
      const e = pkgEntries[i];
      addNode(e.id, "entryNode", 3 + i, row, { entry: e });
      connect(e.id);
    }

    let ghostPkgCol = 3 + pkgEntries.length;
    if (!hasCan) {
      const id = `ghost-canning-${branch ?? "main"}`;
      addNode(id, "ghostNode", ghostPkgCol++, row, { stage: "canning", label: "Canning", isRequired: false });
      connect(id);
    }
    if (!hasKeg) {
      const id = `ghost-kegging-${branch ?? "main"}`;
      addNode(id, "ghostNode", ghostPkgCol++, row, { stage: "kegging", label: "Kegging", isRequired: false });
      connect(id);
    }

    if (prevId) trackEndNodeId.set(branch, prevId);
  }

  // Build main track first (populates mainNodeIdByStage)
  buildTrack(mainEntries, null, 0);

  // Build split branches
  for (let i = 0; i < branchNames.length; i++) {
    const branch   = branchNames[i];
    const bEntries = active.filter(e => e.planned_branch === branch);
    buildTrack(bEntries, branch, i + 1);
  }

  // Conversion volume taken directly out of a given piece of equipment (e.g. a
  // fermenter), keyed by that equipment's id — a converted-away portion is a
  // legitimate downstream sink, not shrinkage.
  const conversionVolumeBySourceEquipmentId = new Map<string, number>();
  if (batch) {
    const plannedConvEntriesForShrinkage = active.filter(e => e.stage === "planned_conversion");
    for (const cb of allBatches.filter(b => b.converted_from_batch_id === batch.id)) {
      const sourceTx = allTransfers
        .filter(t => t.batch_id === batch.id && t.transfer_type === "conversion" && t.to_batch_id === cb.id)
        .sort((a, b) => new Date(a.transferred_at).getTime() - new Date(b.transferred_at).getTime())[0];
      let sourceEquipmentId: string | null = null;
      let volumeBbl = 0;
      if (sourceTx) {
        sourceEquipmentId = sourceTx.from_tank_id;
        volumeBbl = Number(sourceTx.volume_bbl);
      } else {
        const marker = plannedConvEntriesForShrinkage.find(e => {
          try { return JSON.parse(e.notes ?? "{}").child_batch_id === cb.id; } catch { return false; }
        });
        if (!marker) continue;
        sourceEquipmentId = marker.equipment_id;
        volumeBbl = Number(marker.volume_bbl ?? cb.volume_bbl ?? 0);
      }
      if (!sourceEquipmentId) continue;
      conversionVolumeBySourceEquipmentId.set(
        sourceEquipmentId,
        (conversionVolumeBySourceEquipmentId.get(sourceEquipmentId) ?? 0) + volumeBbl,
      );
    }
  }

  // ── Shrinkage between pipeline stages (prior to packaging) ─────────────
  // Shrinkage = upstream stage volume minus the sum of everything that came
  // out of it downstream (main track, any splits that forked there, and any
  // amount converted away directly from that stage's equipment).
  // e.g. Brewing 40 bbl → Fermenting 36 bbl = 4 bbl shrinkage. If Fermenting's
  // 36 bbl is then split into two Conditioning branches of 20 + 14, that's a
  // further 2 bbl of shrinkage attributed to the Fermenting → Conditioning step.
  // But if Fermenting's 40 bbl instead splits into a 10 bbl Conditioning branch
  // and a 30 bbl converted batch, that's 40 bbl fully accounted for — no shrinkage.
  const shrinkageLabelByUpstreamNodeId = new Map<string, string>();
  // Same-edge alternative to shrinkage: the upstream tank hasn't fully drained
  // yet (still mid partial-transfer), so the volume gap is "still arriving",
  // not unaccounted-for loss. Mutually exclusive with shrinkage per edge.
  const partialFillLabelByUpstreamNodeId = new Map<string, string>();
  for (let i = 0; i < MAIN_PIPELINE.length - 1; i++) {
    const upstreamStage   = MAIN_PIPELINE[i];
    const downstreamStage = MAIN_PIPELINE[i + 1];
    const upstreamEntry = mainEntries.find(e => normStage(e.stage) === upstreamStage);
    if (!upstreamEntry?.volume_bbl) continue;

    const upstreamVol = arrivedVolume(upstreamEntry, batch, allTransfers);

    const mainDownstreamEntry = mainEntries.find(e => normStage(e.stage) === downstreamStage);
    // Use the downstream tank's reconstructed arrived total too — if it's also
    // mid partial-drain (e.g. 25/36 bbl already moved onward), its volume_bbl
    // reflects only what's still sitting there, not everything it received
    // from upstream.
    let downstreamTotal = arrivedVolume(mainDownstreamEntry, batch, allTransfers);
    for (const b of branchStartInfo) {
      if (b.originStage === upstreamStage && b.startStage === downstreamStage) downstreamTotal += b.volume;
    }
    if (upstreamEntry.equipment_id) {
      downstreamTotal += conversionVolumeBySourceEquipmentId.get(upstreamEntry.equipment_id) ?? 0;
    }

    const gap = upstreamVol - downstreamTotal;
    if (gap <= 0.01) continue;

    const upstreamNodeId = mainNodeIdByStage.get(upstreamStage);
    if (!upstreamNodeId) continue;

    // Upstream tank still open (not fully drained) and downstream has started
    // receiving but hasn't closed out — this is an in-progress partial transfer.
    const stillArriving =
      upstreamEntry.actual_end == null &&
      mainDownstreamEntry?.actual_start != null &&
      mainDownstreamEntry?.actual_end == null;

    if (stillArriving) {
      partialFillLabelByUpstreamNodeId.set(upstreamNodeId, `+${gap.toFixed(2)} BBL more expected`);
    } else {
      shrinkageLabelByUpstreamNodeId.set(upstreamNodeId, `−${gap.toFixed(2)} BBL shrinkage`);
    }
  }

  // ── Converted batches ───────────────────────────────────────────────────
  // Treat a conversion like a branch: it gets its own row below all other
  // tracks rather than sitting in-line with the row it forked from.
  if (batch) {
    let nextConvRow = 1 + branchNames.length;
    const plannedConvEntries = active.filter(e => e.stage === "planned_conversion");

    for (const cb of allBatches.filter(b => b.converted_from_batch_id === batch.id)) {
      // Prefer an already-executed transfer (the conversion physically happened);
      // otherwise fall back to the still-pending planned_conversion marker.
      const sourceTx = allTransfers
        .filter(t => t.batch_id === batch.id && t.transfer_type === "conversion" && t.to_batch_id === cb.id)
        .sort((a, b) => new Date(a.transferred_at).getTime() - new Date(b.transferred_at).getTime())[0];

      let sourceEquipmentId: string | null = null;
      let volumeBbl: number;
      if (sourceTx) {
        sourceEquipmentId = sourceTx.from_tank_id;
        volumeBbl = Number(sourceTx.volume_bbl);
      } else {
        const marker = plannedConvEntries.find(e => {
          try { return JSON.parse(e.notes ?? "{}").child_batch_id === cb.id; } catch { return false; }
        });
        if (!marker) continue;
        sourceEquipmentId = marker.equipment_id;
        volumeBbl = Number(marker.volume_bbl ?? cb.volume_bbl ?? 0);
      }

      // Find the node whose entry uses this source tank (any track), else fall
      // back to that track's terminal node.
      const sourceEntry = active.find(e => e.equipment_id === sourceEquipmentId && e.stage !== "planned_conversion");
      const sourceNodeId = sourceEntry
        ? sourceEntry.id
        : trackEndNodeId.get(null);
      if (!sourceNodeId) continue;

      // Read the child batch's own current first schedule entry live, rather
      // than trusting the source's static planned_conversion marker — the
      // child's entry is the single source of truth and may have been edited
      // (date/equipment/volume) independently since the marker was created.
      const childFirstEntry = allScheduleEntries
        .filter(e => e.batch_id === cb.id && !e.cancelled_at)
        .sort((a, b) => (a.planned_start ?? "").localeCompare(b.planned_start ?? ""))[0];

      const convRow = nextConvRow++;
      const sourceCol = sourceEntry ? (STAGE_COL[normStage(sourceEntry.stage)] ?? 2) : 2;
      const convId = `conv-${cb.id}`;
      addNode(convId, "conversionNode", sourceCol + 1, convRow, {
        toBatch: cb,
        volumeBbl: childFirstEntry?.volume_bbl != null ? Number(childFirstEntry.volume_bbl) : volumeBbl,
        plannedDate: childFirstEntry?.planned_start ?? null,
        destinationEquipmentName: childFirstEntry?.equipment?.name ?? null,
        isExecuted: !!sourceTx,
      });
      addEdge(sourceNodeId, convId);
    }
  }

  const edgesWithShrinkage: Edge[] = allEdges.map(edge => {
    const partialFillLabel = partialFillLabelByUpstreamNodeId.get(edge.source);
    const shrinkageLabel   = shrinkageLabelByUpstreamNodeId.get(edge.source);
    const label = partialFillLabel ?? shrinkageLabel;
    if (!label) return edge;
    return {
      ...edge,
      label,
      labelStyle: { fill: partialFillLabel ? "#facc15" : "#f87171", fontSize: 10, fontWeight: 600 },
      labelBgStyle: { fill: "#27272a", fillOpacity: 0.9 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
    };
  });

  return { nodes: allNodes, edges: edgesWithShrinkage };
}
