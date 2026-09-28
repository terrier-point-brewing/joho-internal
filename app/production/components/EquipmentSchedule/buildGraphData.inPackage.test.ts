import { describe, it, expect } from "vitest";
import { buildGraphData } from "./buildGraphData";
import type { ScheduleEntry } from "../../hooks/queries";
import type { BrewBatch, BatchConversion } from "../../types";

/**
 * An in-keg conversion has no vessel: the dose goes into each keg as the
 * source is packaged. The source's graph hangs the conversion off that
 * kegging RUN, and the child's graph is that one run — never a phantom
 * "Conditioning — schedule needed" ghost.
 */

const SRC = "src";
const CHILD = "child";
const STATION = "kegging-station";

function entry(id: string, batchId: string, stage: string, equipmentId: string | null, date: string, vol: number): ScheduleEntry {
  return {
    id, batch_id: batchId, equipment_id: equipmentId, stage,
    planned_start: date, planned_end: date, actual_start: null, actual_end: null,
    cancelled_at: null, cancellation_reason: null, notes: null,
    volume_bbl: vol, downstream_entry_id: null, planned_branch: null,
  };
}

const source = { id: SRC, beer_name: "Pilsner", batch_number: "B-100", volume_bbl: 40, converted_from_batch_id: null } as BrewBatch;
const child  = { id: CHILD, beer_name: "Orange Pilsner", batch_number: "B-101", volume_bbl: 2, converted_from_batch_id: SRC } as BrewBatch;

const plan: BatchConversion = {
  id: "plan", source_batch_id: SRC, target_batch_id: CHILD, source_equipment_id: STATION,
  volume_bbl: 2, planned_date: "2026-10-10", converted_at: null, notes: null,
  created_at: "2026-09-28", method: "in_package",
};

const srcEntries = [
  entry("brew", SRC, "brewhouse", "bh", "2026-09-01", 40),
  entry("ferm", SRC, "fermenting", "fv", "2026-09-02", 40),
  entry("cond", SRC, "conditioning", "brite", "2026-09-20", 40),
  entry("keg", SRC, "kegging", STATION, "2026-10-10", 28),
  entry("can", SRC, "canning", "canner", "2026-10-11", 12),
];
const childEntries = [entry("child-keg", CHILD, "kegging", STATION, "2026-10-10", 2)];
const all = [...srcEntries, ...childEntries];

describe("in-package conversion on the Equipment Schedule", () => {
  it("hangs the source's planned conversion off its kegging run", () => {
    const { nodes, edges } = buildGraphData(srcEntries, [source, child], source, [], all, [plan]);
    expect(edges.some(e => e.source === "keg" && e.target === `conv-${CHILD}`)).toBe(true);
    const conv = nodes.find(n => n.id === `conv-${CHILD}`)!;
    expect(conv.data.inPackage).toBe("keg");
    expect(nodes.find(n => n.id === "keg")!.data.pendingConversionBbl).toBe(2);
  });

  it("draws the child as its one run, with no conditioning ghost", () => {
    const { nodes } = buildGraphData(childEntries, [source, child], child, [], all, [plan]);
    expect(nodes.map(n => n.id)).toEqual(["child-keg"]);
    expect(nodes[0].position.x).toBe(0);
  });

  it("a tank conversion child still gets its conditioning stage", () => {
    const tankPlan = { ...plan, method: "tank" as const, source_equipment_id: "brite" };
    const { nodes } = buildGraphData([], [source, child], child, [], all, [tankPlan]);
    expect(nodes.some(n => n.id === "ghost-conditioning-main")).toBe(true);
  });
});
