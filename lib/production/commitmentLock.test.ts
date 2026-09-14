import { describe, it, expect } from "vitest";
import { lockedFieldsChanged, unlockNote } from "./commitmentLock";

const current = { recipe_id: "r1", partner_id: "p1", channel: "contract_brewing", volume_bbl: "30.00" };

describe("lockedFieldsChanged", () => {
  it("ignores fields not in the patch and values that did not actually change", () => {
    expect(lockedFieldsChanged(current, { notes: "x" } as never)).toEqual([]);
    expect(lockedFieldsChanged(current, { volume_bbl: 30, recipe_id: "r1" })).toEqual([]);
  });
  it("names the locked fields that change", () => {
    expect(lockedFieldsChanged(current, { volume_bbl: 28, recipe_id: "r2", partner_id: "p1" })).toEqual(["recipe_id", "volume_bbl"]);
  });
  it("treats null and empty the same", () => {
    expect(lockedFieldsChanged({ ...current, partner_id: null }, { partner_id: "" })).toEqual([]);
  });
});

describe("unlockNote", () => {
  it("reads as a dated audit line", () => {
    expect(unlockNote("2026-09-13", ["volume_bbl"], " partner asked for 2 fewer bbl ")).toBe(
      "[2026-09-13 changed volume after lock: partner asked for 2 fewer bbl]",
    );
  });
});
