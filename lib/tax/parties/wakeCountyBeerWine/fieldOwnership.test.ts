import { describe, it, expect } from "vitest";
import { resolveWakeBeerWineFieldOwnership } from "./fieldOwnership";

describe("resolveWakeBeerWineFieldOwnership", () => {
  it("treats every fee line and the total as computed", () => {
    for (const key of [
      "wake_bw_fee_on_premise_malt_cents",
      "wake_bw_fee_off_premise_malt_cents",
      "wake_bw_fee_on_premise_wine_cents",
      "wake_bw_fee_off_premise_wine_cents",
      "wake_bw_license_count",
      "wake_bw_total_fee_cents",
    ]) {
      expect(resolveWakeBeerWineFieldOwnership(key), key).toBe("computed");
    }
  });

  it("treats anything else as manual", () => {
    expect(resolveWakeBeerWineFieldOwnership("wake_tax_owed_cents")).toBe("manual");
  });
});
