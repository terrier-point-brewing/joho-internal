import { describe, it, expect } from "vitest";
import { wakeCountyBeerWineTemplate as t } from "./template";
import { periodsNeedingTasks } from "@/lib/tax/tasks";

describe("wakeCountyBeerWineTemplate", () => {
  it("uses the May 1 – April 30 license year", () => {
    expect(t.supportedFrequencies).toEqual(["annual"]);
    const mid = t.computePeriod("annual", new Date("2026-07-15T12:00:00Z"));
    expect(mid.start).toBe("2026-05-01");
    expect(mid.end).toBe("2027-04-30");

    // A January date falls in the license year that started the previous May.
    const jan = t.computePeriod("annual", new Date("2027-01-15T12:00:00Z"));
    expect(jan.start).toBe("2026-05-01");
    expect(jan.end).toBe("2027-04-30");
  });

  it("carries the NEXT April 30 renewal deadline, so the task opens a year before it is due", () => {
    expect(t.defaultDueRule("annual")).toEqual({ fixedMonth: 4, day: 30 });
    const p = t.computePeriod("annual", new Date("2026-06-01T12:00:00Z"));
    expect(p.end).toBe("2027-04-30");
    expect(p.due).toBe("2028-04-30");

    // The task for a license year opens the day after that year closes, and
    // its deadline is still ahead — the whole point of the 12-month offset.
    const periods = periodsNeedingTasks("annual", new Date(Date.UTC(2027, 4, 1, 12)), 400, t);
    expect(periods.map((x) => x.end)).toContain("2027-04-30");
    expect(periods.find((x) => x.end === "2027-04-30")!.due).toBe("2028-04-30");
  });

  it("rejects unsupported frequencies", () => {
    expect(() => t.defaultDueRule("monthly")).toThrow();
    expect(() => t.computePeriod("quarterly", new Date("2026-07-15T12:00:00Z"))).toThrow();
  });

  it("declares the required Wake County account and on-premise ABC permit registrations", () => {
    expect(t.requiredRegistrations).toContainEqual({
      authorityKey: "wake_county",
      registrationKey: "wake_county_account_id",
      label: "Wake County Gross Receipts Account Number",
      identityOrder: 1,
    });
    expect(t.requiredRegistrations).toContainEqual({
      authorityKey: "nc_abc",
      registrationKey: "abc_permit_number_onpremise",
      label: "NC ABC On-Premise Permit Number",
      identityOrder: 3,
    });
  });

  it("declares the county PIN as a shared SENSITIVE registration, not a per-module setting", () => {
    expect(t.settingsSchema).toEqual([]);
    expect(t.requiredRegistrations).toContainEqual({
      authorityKey: "wake_county",
      registrationKey: "wake_county_pin",
      label: "Wake County Gross Receipts PIN",
      identityOrder: 2,
      sensitive: true,
    });
  });

  it("offers the four license types as a required multiselect schedule config", () => {
    const field = t.scheduleConfigSchema.find((f) => f.key === "license_types");
    expect(field?.type).toBe("multiselect");
    expect(field?.required).toBe(true);
    expect(field?.options?.map((o) => o.value)).toEqual([
      "on_premise_malt",
      "off_premise_malt",
      "on_premise_wine",
      "off_premise_wine",
    ]);
  });

  it("mergeWorksheet fully replaces fields with the recompute (all fields computed)", () => {
    const current = { fields: { wake_bw_total_fee_cents: 111, stray: "keep?" } };
    const recomputed = { fields: { wake_bw_total_fee_cents: 5000 }, meta: { computedAt: "t" } };
    expect(t.mergeWorksheet(current, recomputed, {}).fields).toEqual({ wake_bw_total_fee_cents: 5000 });
  });

  it("buildReferenceView publishes the statutory fee schedule and ignores the rate map", () => {
    const ref = t.buildReferenceView({});
    expect(ref.tables[0].rows).toEqual([
      ["On-premises malt beverage", "$25.00"],
      ["Off-premises malt beverage", "$5.00"],
      ["On-premises wine", "$25.00"],
      ["Off-premises wine", "$25.00"],
    ]);
  });
});
