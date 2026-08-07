import { describe, it, expect } from "vitest";
import { buildGraphData } from "./buildGraphData";
import type { ScheduleEntry } from "../../hooks/queries";
import type { BrewBatch, BatchTransfer } from "../../types";

/**
 * Pins how a packaging run's shrinkage is attributed to its nodes.
 *
 * A run of several variations writes one batch_transfers row AND one
 * batch_schedule_entries row per variation (transfers/route.ts loops
 * packaging_lines), every one of them stamped with the same date. Matching a
 * node to its transfers on date alone therefore matched EVERY line to EVERY
 * node, and the run's whole loss was redrawn once per variation — B-028's
 * 0.9385 BBL tank heel showed up on both of its 2026-08-07 kegging nodes.
 */

const BATCH_ID = "batch-1";
const KEGGING_TANK = "kegging-station";

const batch = {
  id: BATCH_ID,
  beer_name: "Carolina Brown Ale",
  batch_number: "B-028",
  volume_bbl: 40,
  converted_from_batch_id: null,
} as BrewBatch;

function keggingEntry(id: string, volumeBbl: number | null, date = "2026-08-07"): ScheduleEntry {
  return {
    id,
    batch_id: BATCH_ID,
    equipment_id: KEGGING_TANK,
    stage: "kegging",
    planned_start: date,
    planned_end: date,
    actual_start: date,
    actual_end: date,
    cancelled_at: null,
    cancellation_reason: null,
    notes: null,
    volume_bbl: volumeBbl,
    downstream_entry_id: null,
    planned_branch: null,
  };
}

function keggingTransfer(id: string, volumeBbl: number, shrinkageBbl: number, date = "2026-08-07"): BatchTransfer {
  return {
    id,
    batch_id: BATCH_ID,
    from_tank_id: "fv-31",
    to_tank_id: KEGGING_TANK,
    volume_bbl: volumeBbl,
    shrinkage_bbl: shrinkageBbl,
    transfer_type: "kegging",
    notes: null,
    variation_id: null,
    quantity: null,
    transferred_at: `${date}T12:00:00+00:00`,
    to_batch_id: null,
  };
}

/** The shrinkage each entry's node ended up displaying. */
function shrinkageByEntryId(entries: ScheduleEntry[], transfers: BatchTransfer[]) {
  const { nodes } = buildGraphData(entries, [batch], batch, transfers);
  return Object.fromEntries(
    nodes
      .filter((n) => n.type === "entryNode")
      .map((n) => [n.id, (n.data as { packagingShrinkageBbl?: number }).packagingShrinkageBbl]),
  );
}

describe("packaging shrinkage attribution", () => {
  it("splits a multi-variation run across its nodes instead of repeating the total on each", () => {
    // B-028's real 2026-08-07 run: 3 x 1/2 keg + 6 x 1/6 keg, 0.9385 BBL of heel.
    const entries = [keggingEntry("entry-half", 1.5), keggingEntry("entry-sixth", 0.999)];
    const transfers = [
      keggingTransfer("tx-half", 1.5, 0.563),
      keggingTransfer("tx-sixth", 0.99949596774193548387, 0.37550403225806451613),
    ];

    const shrinkage = shrinkageByEntryId(entries, transfers);

    expect(shrinkage["entry-half"]).toBeCloseTo(0.563, 6);
    expect(shrinkage["entry-sixth"]).toBeCloseTo(0.37550403225806451613, 6);
    // The run lost 0.9385 BBL once, not 0.9385 per variation.
    const total = Object.values(shrinkage).reduce((s: number, v) => s + (v ?? 0), 0);
    expect(total).toBeCloseTo(0.93850403225806451613, 6);
  });

  it("still shows the whole loss on a single-variation run", () => {
    const shrinkage = shrinkageByEntryId(
      [keggingEntry("entry-only", 4.997)],
      [keggingTransfer("tx-only", 4.997479838709677, 0.502520161290323)],
    );
    expect(shrinkage["entry-only"]).toBeCloseTo(0.502520161290323, 6);
  });

  it("lets one node absorb the run when no entry volume matches a transfer", () => {
    // Hand-written / pre-volume_bbl rows: better to show the loss on one node
    // than to drop it off the graph entirely.
    const shrinkage = shrinkageByEntryId(
      [keggingEntry("entry-a", null), keggingEntry("entry-b", null)],
      [keggingTransfer("tx-a", 1.5, 0.25), keggingTransfer("tx-b", 1.0, 0.75)],
    );
    expect(shrinkage["entry-a"]).toBeCloseTo(1.0, 6);
    expect(shrinkage["entry-b"]).toBeUndefined();
  });

  it("does not let a later run claim an earlier run's transfers", () => {
    const entries = [keggingEntry("entry-jun", 4.0, "2026-06-18"), keggingEntry("entry-aug", 1.5, "2026-08-07")];
    const transfers = [
      keggingTransfer("tx-jun", 4.0, 0, "2026-06-18"),
      keggingTransfer("tx-aug", 1.5, 0.563, "2026-08-07"),
    ];

    const shrinkage = shrinkageByEntryId(entries, transfers);

    expect(shrinkage["entry-jun"]).toBeUndefined();
    expect(shrinkage["entry-aug"]).toBeCloseTo(0.563, 6);
  });
});
