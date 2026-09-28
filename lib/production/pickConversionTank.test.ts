import { describe, it, expect } from "vitest";
import { pickConversionTank, type SlotTank } from "./tankSlots";

const tanks: SlotTank[] = [
  { id: "b34", name: "34", type: "brite", capacity_bbl: 80 },
  { id: "b33", name: "33", type: "brite", capacity_bbl: 40 },
  { id: "f11", name: "11", type: "fermenter", capacity_bbl: 40 },
  { id: "keg", name: "Kegging", type: "kegging", capacity_bbl: null },
];
const busy = (id: string, start: string, end: string) => ({ equipment_id: id, planned_start: start, planned_end: end });

describe("pickConversionTank", () => {
  it("takes the smallest free brite that holds the volume", () => {
    expect(pickConversionTank({ tanks, entries: [], volumeBbl: 30, start: "2026-10-16", end: "2026-10-23" })?.id).toBe("b33");
  });

  it("skips a brite booked inside the window and never slides the date", () => {
    const entries = [busy("b33", "2026-10-20", "2026-10-30")];
    expect(pickConversionTank({ tanks, entries, volumeBbl: 30, start: "2026-10-16", end: "2026-10-23" })?.id).toBe("b34");
  });

  it("falls back to a fermenter, then to nothing", () => {
    const entries = [busy("b33", "2026-10-01", "2026-11-01"), busy("b34", "2026-10-01", "2026-11-01")];
    expect(pickConversionTank({ tanks, entries, volumeBbl: 30, start: "2026-10-16", end: "2026-10-23" })?.id).toBe("f11");
    expect(pickConversionTank({ tanks, entries, volumeBbl: 50, start: "2026-10-16", end: "2026-10-23" })).toBeNull();
  });

  it("keeps the preferred tank while it is valid, overrides it when not", () => {
    expect(pickConversionTank({ tanks, entries: [], volumeBbl: 30, start: "2026-10-16", end: "2026-10-23", preferredId: "b34" })?.id).toBe("b34");
    expect(pickConversionTank({ tanks, entries: [], volumeBbl: 50, start: "2026-10-16", end: "2026-10-23", preferredId: "b33" })?.id).toBe("b34");
  });

  it("a booking that ends the day the conversion starts is not a clash", () => {
    const entries = [busy("b33", "2026-10-01", "2026-10-16")];
    expect(pickConversionTank({ tanks, entries, volumeBbl: 30, start: "2026-10-16", end: "2026-10-23" })?.id).toBe("b33");
  });
});
