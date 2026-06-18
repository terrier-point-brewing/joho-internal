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
      // Main track: fill in the full pipeline, adding ghosts for missing stages
      for (const stage of MAIN_PIPELINE) {
        const entry = nonPkgMap.get(stage);
        const col   = STAGE_COL[stage];
        if (entry) {
          addNode(entry.id, "entryNode", col, row, { entry });
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

      // Stages from startStage forward
      const branchPipeline = MAIN_PIPELINE.slice(MAIN_PIPELINE.indexOf(startStage));
      for (const stage of branchPipeline) {
        const entry = nonPkgMap.get(stage);
        const col   = STAGE_COL[stage];
        if (entry) {
          addNode(entry.id, "entryNode", col, row, { entry });
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

    // ── Actual conversions from this track ────────────────────────────────
    if (batch) {
      for (const cb of allBatches.filter(b => b.converted_from_batch_id === batch.id)) {
        const sourceTx = allTransfers
          .filter(t => t.batch_id === batch.id && t.transfer_type === "conversion" && t.to_batch_id === cb.id)
          .sort((a, b) => new Date(a.transferred_at).getTime() - new Date(b.transferred_at).getTime())[0];
        if (sourceTx) {
          // Find the node whose entry uses this source tank
          const sourceEntry = trackEntries.find(e => e.equipment_id === sourceTx.from_tank_id);
          const sourceNodeId = sourceEntry ? sourceEntry.id : prevId;
          if (sourceNodeId) {
            const convId = `conv-${cb.id}`;
            addNode(convId, "conversionNode", (branch ? 4 : 4), row, {
              toBatch: cb,
              volumeBbl: Number(sourceTx.volume_bbl),
            });
            addEdge(sourceNodeId, convId);
          }
        }
      }
    }
  }

  // Build main track first (populates mainNodeIdByStage)
  buildTrack(mainEntries, null, 0);

  // Build split branches
  for (let i = 0; i < branchNames.length; i++) {
    const branch   = branchNames[i];
    const bEntries = active.filter(e => e.planned_branch === branch);
    buildTrack(bEntries, branch, i + 1);
  }

  return { nodes: allNodes, edges: allEdges };
}
