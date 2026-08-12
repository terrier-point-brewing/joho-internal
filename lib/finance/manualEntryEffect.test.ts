import { describe, it, expect } from "vitest";
import { manualEntryEffect } from "./manualEntryEffect";

describe("manualEntryEffect", () => {
  it("says nothing when the kind is one the account reads", () => {
    expect(manualEntryEffect({ entryKind: "flow", accepted: ["flow"] })).toEqual({ level: "ok" });
    expect(manualEntryEffect({ entryKind: "balance", accepted: ["balance"] })).toEqual({ level: "ok" });
  });

  it("says nothing on an account that reads both", () => {
    // Square: a stated balance anchors it, and it has a postings step too.
    expect(manualEntryEffect({ entryKind: "flow", accepted: ["flow", "balance"] }).level).toBe("ok");
    expect(manualEntryEffect({ entryKind: "balance", accepted: ["flow", "balance"] }).level).toBe("ok");
  });

  it("warns, and names the kind that would work, on a calculated account", () => {
    // The GL 2220 case: somebody reaches for Balance to correct a tax liability.
    const effect = manualEntryEffect({ entryKind: "balance", accepted: ["flow"] });
    expect(effect.level).toBe("warn");
    if (effect.level !== "warn") throw new Error("expected warn");
    expect(effect.message).toContain("Switch to Transaction");
    // Says why it is safe to only do it once, which is the thing that makes the
    // advice actionable rather than just corrective.
    expect(effect.message).toContain("carry forward");
  });

  it("warns the other way round on a feed-backed account", () => {
    const effect = manualEntryEffect({ entryKind: "flow", accepted: ["balance"] });
    expect(effect.level).toBe("warn");
    if (effect.level !== "warn") throw new Error("expected warn");
    expect(effect.message).toContain("Switch to Balance");
    // And says the override does not carry forward, which is the opposite
    // promise and the one that makes the two kinds distinguishable.
    expect(effect.message).toContain("that month only");
  });

  it("tells an unsourced account it will start counting later", () => {
    // Not a warning: the entry is not wrong, it is early. Saving it is a
    // reasonable thing to do before the account is configured.
    const effect = manualEntryEffect({ entryKind: "flow", accepted: null });
    expect(effect.level).toBe("info");
  });

  it("warns plainly when neither kind can reach the account", () => {
    const effect = manualEntryEffect({ entryKind: "flow", accepted: [] });
    expect(effect.level).toBe("warn");
    if (effect.level !== "warn") throw new Error("expected warn");
    expect(effect.message).not.toContain("Switch to");
  });
});
