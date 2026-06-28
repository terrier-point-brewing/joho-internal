import { type Node, type Edge, MarkerType, Position } from "@xyflow/react";
import type { ScheduleEntry } from "../../hooks/queries";
import type { BrewBatch, BatchTransfer, BatchConversion } from "../../types";
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
    // Same-tank transfers (from_tank_id === to_tank_id) are stage changes in
    // place, e.g. fermenting -> conditioning without moving vessels. No volume
    // actually left the tank, so they must not count as a "departure" here —
    // otherwise the still-present volume gets added back on top of itself.
    const departedTotal = allTransfers
      .filter(t => t.batch_id === batch.id && t.from_tank_id === entry.equipment_id && t.to_tank_id !== entry.equipment_id)
      .reduce((sum, t) => sum + Number(t.volume_bbl) + Number(t.shrinkage_bbl ?? 0), 0);
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
    .filter(t => t.batch_id === batch.id && t.from_tank_id === entry.equipment_id && t.to_tank_id !== entry.equipment_id)
    .reduce((sum, t) => sum + Number(t.volume_bbl) + Number(t.shrinkage_bbl ?? 0), 0);
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
  allBatchConversions: BatchConversion[] = [],
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

  // Edge ID → split volume (BBL): fork edges get an indigo volume label.
  const splitForkEdges = new Map<string, number>();
  // Node ID → BBL converted out of that node's tank, split by completion state.
  const completedConvBblByNodeId = new Map<string, number>();
  const pendingConvBblByNodeId   = new Map<string, number>();

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
    // Non-null only before the first connect() call in a split branch — captured
    // onto the fork edge so it gets an indigo volume label, then reset to null.
    let pendingForkVol: number | null = null;

    const connect = (targetId: string) => {
      if (prevId) {
        const edgeId = `${prevId}->${targetId}`;
        allEdges.push({ id: edgeId, source: prevId, target: targetId, ...EDGE_DEFAULTS });
        if (pendingForkVol !== null && pendingForkVol > 0.001) {
          splitForkEdges.set(edgeId, pendingForkVol);
          pendingForkVol = null;
        }
      }
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

      // Fork edge: from the main track node at the stage BEFORE startStage.
      // Set pendingForkVol first so connect() stamps it onto the fork edge.
      pendingForkVol = Number(nonPkgMap.get(startStage)?.volume_bbl ?? 0);
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
      const pkgShrinkage = batch
        ? allTransfers
            .filter(t => {
              if (t.batch_id !== batch.id || t.to_tank_id !== e.equipment_id || t.transfer_type !== e.stage) return false;
              // When multiple sessions go to the same equipment (e.g. two kegging runs),
              // scope each entry to its own date so shrinkage isn't double-counted.
              const entryStart = (e.actual_start ?? e.planned_start ?? "").slice(0, 10);
              const entryEnd   = (e.actual_end   ?? e.planned_end   ?? "").slice(0, 10);
              const txDate     = (t.transferred_at ?? "").slice(0, 10);
              return !entryStart || (txDate >= entryStart && txDate <= entryEnd);
            })
            .reduce((sum, t) => sum + Number(t.shrinkage_bbl ?? 0), 0)
        : 0;
      addNode(e.id, "entryNode", 3 + i, row, {
        entry: e,
        packagingShrinkageBbl: pkgShrinkage > 0.001 ? pkgShrinkage : undefined,
      });
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
    const pendingConversions = allBatchConversions.filter(
      c => c.source_batch_id === batch.id && !c.converted_at
    );
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
        const conv = pendingConversions.find(c => c.target_batch_id === cb.id);
        if (!conv?.source_equipment_id) continue;
        sourceEquipmentId = conv.source_equipment_id;
        volumeBbl = Number(conv.volume_bbl);
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
  // Displayed inside the upstream node body (same pattern as packaging nodes).
  const shrinkageBblByNodeId = new Map<string, number>();
  // Still-arriving alternative: upstream tank mid partial-drain while downstream
  // is already filling — the gap is "en route", not lost. Shown on the edge.
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
      shrinkageBblByNodeId.set(upstreamNodeId, gap);
    }
  }

  // ── Converted batches ───────────────────────────────────────────────────
  // Treat a conversion like a branch: it gets its own row below all other
  // tracks rather than sitting in-line with the row it forked from.
  if (batch) {
    let nextConvRow = 1 + branchNames.length;

    for (const cb of allBatches.filter(b => b.converted_from_batch_id === batch.id)) {
      // Prefer an already-executed transfer (the conversion physically happened);
      // otherwise fall back to the pending batch_conversions record.
      const sourceTx = allTransfers
        .filter(t => t.batch_id === batch.id && t.transfer_type === "conversion" && t.to_batch_id === cb.id)
        .sort((a, b) => new Date(a.transferred_at).getTime() - new Date(b.transferred_at).getTime())[0];

      let sourceEquipmentId: string | null = null;
      let volumeBbl: number;
      if (sourceTx) {
        sourceEquipmentId = sourceTx.from_tank_id;
        volumeBbl = Number(sourceTx.volume_bbl);
      } else {
        const conv = allBatchConversions.find(c => c.source_batch_id === batch.id && c.target_batch_id === cb.id);
        if (!conv?.source_equipment_id) continue;
        sourceEquipmentId = conv.source_equipment_id;
        volumeBbl = Number(conv.volume_bbl);
      }

      // Find the node whose entry uses this source tank (any track), else fall
      // back to that track's terminal node. Prefer the most downstream stage
      // (conditioning > fermenting) when the same tank hosts multiple stages.
      const CONVERSION_STAGE_RANK: Record<string, number> = { brewhouse: 0, fermenting: 1, fermenter: 1, conditioning: 2 };
      const sourceEntry = [...active]
        .filter(e => e.equipment_id === sourceEquipmentId && e.stage !== "planned_conversion")
        .sort((a, b) => (CONVERSION_STAGE_RANK[b.stage] ?? 0) - (CONVERSION_STAGE_RANK[a.stage] ?? 0))[0];
      const sourceNodeId = sourceEntry
        ? sourceEntry.id
        : trackEndNodeId.get(null);
      if (!sourceNodeId) continue;

      const convMap = sourceTx ? completedConvBblByNodeId : pendingConvBblByNodeId;
      convMap.set(sourceNodeId, (convMap.get(sourceNodeId) ?? 0) + volumeBbl);

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

  // ── Post-process nodes: inject stage shrinkage + conversion BBL ──────────
  const finalNodes = allNodes.map(n => {
    const shrinkageBbl     = shrinkageBblByNodeId.get(n.id);
    const completedConvBbl = completedConvBblByNodeId.get(n.id);
    const pendingConvBbl   = pendingConvBblByNodeId.get(n.id);
    if (shrinkageBbl == null && completedConvBbl == null && pendingConvBbl == null) return n;
    return {
      ...n,
      data: {
        ...n.data,
        ...(shrinkageBbl     != null ? { stageShrinkageBbl: shrinkageBbl }     : {}),
        ...(completedConvBbl != null ? { conversionBbl: completedConvBbl }      : {}),
        ...(pendingConvBbl   != null ? { pendingConversionBbl: pendingConvBbl } : {}),
      },
    };
  });

  // ── Edge labels: partialFill (yellow, on edge) + split fork vol (indigo) ─
  const finalEdges: Edge[] = allEdges.map(edge => {
    const partialFillLabel = partialFillLabelByUpstreamNodeId.get(edge.source);
    const splitVol         = splitForkEdges.get(edge.id);
    if (partialFillLabel) {
      return {
        ...edge,
        label: partialFillLabel,
        labelStyle: { fill: "#facc15", fontSize: 10, fontWeight: 600 },
        labelBgStyle: { fill: "#27272a", fillOpacity: 0.9 },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 4,
      };
    }
    if (splitVol != null && splitVol > 0.001) {
      return {
        ...edge,
        label: `${splitVol.toFixed(2)} BBL`,
        labelStyle: { fill: "#818cf8", fontSize: 10, fontWeight: 600 },
        labelBgStyle: { fill: "#27272a", fillOpacity: 0.9 },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 4,
      };
    }
    return edge;
  });

  return { nodes: finalNodes, edges: finalEdges };
}
