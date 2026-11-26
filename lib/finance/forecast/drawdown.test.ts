import { describe, expect, it } from "vitest";
import { addMonths, buildDrawdownHistory, daysBetween, monthBounds, projectShipments, shippedShareAt } from "./drawdown";
import { DRAWDOWN_CHANNELS, type DrawdownChannel } from "./types";

const ASOF = "2026-11-25";

describe("date helpers", () => {
  it("crosses a year end", () => {
    expect(addMonths("2026-11", 3)).toBe("2027-02");
    expect(addMonths("2027-01", -2)).toBe("2026-11");
    expect(monthBounds("2026-12")).toEqual({ start: "2026-12-01", end: "2027-01-01" });
    expect(daysBetween("2026-12-25", "2027-01-01")).toBe(7);
  });
});

describe("buildDrawdownHistory", () => {
  const batches = [
    { id: "old", brewDate: "2026-05-01", bbl: 100 },
    { id: "young", brewDate: "2026-11-01", bbl: 100 },
  ];
  const shipments = [
    { batchId: "old", channel: "contract_brewing" as const, date: "2026-05-15", bbl: 30 }, // day 14
    { batchId: "old", channel: "contract_brewing" as const, date: "2026-06-12", bbl: 30 }, // day 42
    { batchId: "old", channel: "distribution" as const, date: "2026-06-26", bbl: 20 }, // day 56
    { batchId: "young", channel: "contract_brewing" as const, date: "2026-11-05", bbl: 50 },
  ];
  const h = buildDrawdownHistory(ASOF, batches, shipments);

  it("learns only from batches old enough to have finished shipping", () => {
    expect(h.matureBatchCount).toBe(1);
    // The young batch's fast 50 bbl is ignored: 60 of 100 mature bbl went to contract.
    expect(h.shipFraction.contract_brewing).toBeCloseTo(0.6);
    expect(h.shipFraction.distribution).toBeCloseTo(0.2);
    expect(h.shipFraction.taproom).toBe(0);
  });

  it("builds a cumulative curve that starts at 0 and ends at 1", () => {
    const curve = h.curves.contract_brewing;
    expect(curve[0]).toBe(0);
    expect(curve[curve.length - 1]).toBe(1);
    expect(shippedShareAt(curve, h.curveStepDays, 14)).toBeCloseTo(0.5);
    expect(shippedShareAt(curve, h.curveStepDays, 42)).toBeCloseTo(1);
    expect(shippedShareAt(curve, h.curveStepDays, 0)).toBe(0);
    expect(shippedShareAt(curve, h.curveStepDays, 9999)).toBe(1);
  });

  it("lends a channel with no history the all-channel curve", () => {
    expect(h.curves.taproom[h.curves.taproom.length - 1]).toBe(1);
    expect(shippedShareAt(h.curves.taproom, h.curveStepDays, 56)).toBeCloseTo(1);
  });
});

/** Everything ships in the contract channel, evenly over 28 days. */
function linearDrivers(batches: { brewDate: string; bbl: number; shippedBbl: number }[], pace = 0) {
  const curve = [0, 0.25, 0.5, 0.75, 1];
  return {
    asOf: ASOF,
    curveStepDays: 7,
    curves: { contract_brewing: curve, distribution: curve, taproom: curve },
    shipFraction: { contract_brewing: 0.8, distribution: 0, taproom: 0 },
    batches,
    brewPaceBblPerMonth: pace,
  };
}
const HISTORY = { brewBblPerMonth: null, drawdownSpeedPct: 0, yieldLossPct: 0 };
const total = (p: Record<DrawdownChannel, Record<string, number>>, months: string[]) =>
  DRAWDOWN_CHANNELS.reduce((sum, c) => sum + months.reduce((s, m) => s + p[c][m], 0), 0);

describe("projectShipments", () => {
  const months = ["2026-12", "2027-01", "2027-02"];

  it("ships what an existing batch is still expected to, and no more", () => {
    // Brewed today: 80 of 100 bbl is expected to ship, all inside 28 days.
    // 6 of those days fall in the open month, the rest in December.
    const p = projectShipments(linearDrivers([{ brewDate: ASOF, bbl: 100, shippedBbl: 0 }]), months, HISTORY);
    expect(p.contract_brewing["2026-12"]).toBeCloseTo(80 * (22 / 28));
    expect(p.contract_brewing["2027-01"]).toBe(0);
  });

  it("does not ship beer that has already left", () => {
    const p = projectShipments(linearDrivers([{ brewDate: "2026-11-11", bbl: 100, shippedBbl: 80 }]), months, HISTORY);
    expect(total(p, months)).toBe(0);
  });

  it("gives up on a batch past the end of the curve", () => {
    const p = projectShipments(linearDrivers([{ brewDate: "2026-06-01", bbl: 100, shippedBbl: 10 }]), months, HISTORY);
    expect(total(p, months)).toBe(0);
  });

  it("catches a slow batch up along what is left of the curve", () => {
    // 14 days old (half the curve gone) with nothing shipped: all 80 bbl is
    // still expected, squeezed into the remaining 14 days (6 in November, 8 in December).
    const p = projectShipments(linearDrivers([{ brewDate: "2026-11-11", bbl: 100, shippedBbl: 0 }]), months, HISTORY);
    expect(p.contract_brewing["2026-12"]).toBeCloseTo(80 * (8 / 14));
  });

  it("lets the speed lever re-time beer without creating or losing any", () => {
    // Past the measured curve: stays written off however slow shipping is assumed to be.
    const stale = linearDrivers([{ brewDate: "2026-06-01", bbl: 100, shippedBbl: 10 }]);
    expect(total(projectShipments(stale, months, { ...HISTORY, drawdownSpeedPct: -80 }), months)).toBe(0);
    // Three weeks in with 20 bbl still due: doubling the speed runs it off the
    // end of the curve, so it all ships in the first month instead of vanishing.
    const late = linearDrivers([{ brewDate: "2026-11-04", bbl: 100, shippedBbl: 60 }]);
    const fast = projectShipments(late, months, { ...HISTORY, drawdownSpeedPct: 100 });
    expect(fast.contract_brewing["2026-12"]).toBeCloseTo(20);
    expect(total(fast, months)).toBeCloseTo(20);
  });

  it("brews weekly at the assumed pace and ships it along the curve", () => {
    const base = projectShipments(linearDrivers([], 120), months, HISTORY);
    const doubled = projectShipments(linearDrivers([], 120), months, { ...HISTORY, brewBblPerMonth: 240 });
    expect(total(base, months)).toBeGreaterThan(0);
    expect(total(doubled, months)).toBeCloseTo(2 * total(base, months));
    // A full month of steady brewing ships about pace × ship fraction.
    expect(base.contract_brewing["2027-02"]).toBeGreaterThan(120 * 0.8 * 0.8);
    expect(base.contract_brewing["2027-02"]).toBeLessThan(120 * 0.8 * 1.2);
  });

  it("moves volume earlier when beer ships faster, and loses it to yield", () => {
    const batch = [{ brewDate: ASOF, bbl: 100, shippedBbl: 0 }];
    const slow = projectShipments(linearDrivers(batch), months, { ...HISTORY, drawdownSpeedPct: -50 });
    expect(slow.contract_brewing["2026-12"]).toBeLessThan(80 * (22 / 28));
    expect(slow.contract_brewing["2027-01"]).toBeGreaterThan(0);
    const lossy = projectShipments(linearDrivers(batch), months, { ...HISTORY, yieldLossPct: 10 });
    expect(lossy.contract_brewing["2026-12"]).toBeCloseTo(72 * (22 / 28));
  });
});
