import { describe, it, expect } from "vitest";
import { resolveWakeFieldOwnership, isComputedField } from "./fieldOwnership";

describe("resolveWakeFieldOwnership", () => {
  it("marks every worksheet figure computed", () => {
    for (const key of [
      "wake_gross_receipts_cents",
      "wake_applicable_receipts_cents",
      "wake_tax_owed_cents",
      "wake_collected_fb_cents",
      "wake_rate",
    ]) {
      expect(resolveWakeFieldOwnership(key)).toBe("computed");
      expect(isComputedField(key)).toBe(true);
    }
  });

  it("defaults unknown keys to manual", () => {
    expect(resolveWakeFieldOwnership("something_else")).toBe("manual");
    expect(isComputedField("something_else")).toBe(false);
  });
});
