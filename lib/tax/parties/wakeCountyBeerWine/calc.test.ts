import { describe, it, expect } from "vitest";
import { computeBeerWineFigures, computeBeerWineWorksheet, readLicenseTypes } from "./calc";
import type { ComputeContext, TaxSchedule } from "@/lib/tax/types";

function ctx(config: Record<string, unknown>): ComputeContext {
  return {
    schedule: { config } as TaxSchedule,
    profile: {},
    period: { start: "2026-05-01", end: "2027-04-30", due: "2028-04-30" },
  };
}

describe("readLicenseTypes", () => {
  it("keeps only known values, dedupes, and returns them in the county's published order", () => {
    expect(readLicenseTypes({ license_types: ["off_premise_wine", "on_premise_malt", "on_premise_malt", "bogus"] }))
      .toEqual(["on_premise_malt", "off_premise_wine"]);
  });

  it("treats a missing or non-array config as no licenses", () => {
    expect(readLicenseTypes(undefined)).toEqual([]);
    expect(readLicenseTypes({})).toEqual([]);
    expect(readLicenseTypes({ license_types: "on_premise_malt" })).toEqual([]);
  });
});

describe("computeBeerWineFigures", () => {
  it("bills each selected license at its statutory fee and totals them", () => {
    const { fields } = computeBeerWineFigures(["on_premise_malt", "off_premise_malt", "on_premise_wine"]);
    expect(fields.wake_bw_fee_on_premise_malt_cents).toBe(2500);
    expect(fields.wake_bw_fee_off_premise_malt_cents).toBe(500);
    expect(fields.wake_bw_fee_on_premise_wine_cents).toBe(2500);
    expect(fields.wake_bw_fee_off_premise_wine_cents).toBeNull();
    expect(fields.wake_bw_license_count).toBe(3);
    expect(fields.wake_bw_total_fee_cents).toBe(5500);
  });

  it("bills all four at $80.00", () => {
    const all = ["on_premise_malt", "off_premise_malt", "on_premise_wine", "off_premise_wine"];
    expect(computeBeerWineFigures(all).fields.wake_bw_total_fee_cents).toBe(8000);
  });

  it("warns (rather than silently reporting $0) when no license type is selected", () => {
    const result = computeBeerWineFigures([]);
    expect(result.fields.wake_bw_total_fee_cents).toBe(0);
    expect(result.warnings?.[0]).toMatch(/No license types selected/);
  });
});

describe("computeBeerWineWorksheet", () => {
  it("reads the selection off the schedule's config", async () => {
    const result = await computeBeerWineWorksheet(ctx({ license_types: ["off_premise_malt"] }));
    expect(result.fields.wake_bw_total_fee_cents).toBe(500);
    expect(result.meta?.provenance).toBe("schedule_config");
    expect(result.warnings).toBeUndefined();
  });
});
