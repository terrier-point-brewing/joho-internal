import { describe, it, expect, beforeEach } from "vitest";
import { registerParty, getParty, listParties } from "./registry";
import type { TaxPartyTemplate } from "./types";

describe("tax registry", () => {
  beforeEach(() => {
    // Reset registry state before each test by clearing and re-importing
    // Note: module-level state persists across tests within a file.
    // We'll use unique keys per test to avoid collisions.
  });

  it("should register a party template and retrieve it", () => {
    const stub: TaxPartyTemplate = {
      key: "nc-dor-su-test-1",
      label: "NC DOR Sales & Use Test 1",
      supportedFrequencies: ["quarterly"],
      computePeriod: () => ({
        start: "2026-01-01",
        end: "2026-03-31",
        due: "2026-04-15",
      }),
      defaultDueRule: () => ({ monthOffset: 1, day: 15 }),
      computeWorksheet: async () => ({ fields: {} }),
      fieldOwnership: {},
      mergeWorksheet: (current) => current,
      settingsSchema: [],
      scheduleConfigSchema: [],
      buildReferenceView: () => ({ tables: [] }),
      worksheetComponent: "NCDORWorksheet",
    };

    registerParty(stub);
    const retrieved = getParty("nc-dor-su-test-1");

    expect(retrieved).toBe(stub);
    expect(retrieved.key).toBe("nc-dor-su-test-1");
    expect(retrieved.label).toBe("NC DOR Sales & Use Test 1");
  });

  it("should throw a clear error when getting an unknown party key", () => {
    expect(() => getParty("unknown-key-xyz")).toThrow(
      /Party template not found: unknown-key-xyz/
    );
  });

  it("should list all registered parties", () => {
    const stub1: TaxPartyTemplate = {
      key: "party-1",
      label: "Party 1",
      supportedFrequencies: ["monthly"],
      computePeriod: () => ({
        start: "2026-01-01",
        end: "2026-01-31",
        due: "2026-02-15",
      }),
      defaultDueRule: () => ({ monthOffset: 1, day: 15 }),
      computeWorksheet: async () => ({ fields: {} }),
      fieldOwnership: {},
      mergeWorksheet: (current) => current,
      settingsSchema: [],
      scheduleConfigSchema: [],
      buildReferenceView: () => ({ tables: [] }),
      worksheetComponent: "Component1",
    };

    const stub2: TaxPartyTemplate = {
      key: "party-2",
      label: "Party 2",
      supportedFrequencies: ["annual"],
      computePeriod: () => ({
        start: "2026-01-01",
        end: "2026-12-31",
        due: "2027-02-15",
      }),
      defaultDueRule: () => ({ monthOffset: 1, day: 15 }),
      computeWorksheet: async () => ({ fields: {} }),
      fieldOwnership: {},
      mergeWorksheet: (current) => current,
      settingsSchema: [],
      scheduleConfigSchema: [],
      buildReferenceView: () => ({ tables: [] }),
      worksheetComponent: "Component2",
    };

    registerParty(stub1);
    registerParty(stub2);

    const parties = listParties();

    expect(parties).toContainEqual(stub1);
    expect(parties).toContainEqual(stub2);
    expect(parties.length).toBeGreaterThanOrEqual(2);
  });

  it("should allow registering multiple parties with different keys", () => {
    const stub1: TaxPartyTemplate = {
      key: "key-a",
      label: "Template A",
      supportedFrequencies: ["quarterly"],
      computePeriod: () => ({
        start: "2026-01-01",
        end: "2026-03-31",
        due: "2026-04-15",
      }),
      defaultDueRule: () => ({ monthOffset: 1, day: 15 }),
      computeWorksheet: async () => ({ fields: {} }),
      fieldOwnership: {},
      mergeWorksheet: (current) => current,
      settingsSchema: [],
      scheduleConfigSchema: [],
      buildReferenceView: () => ({ tables: [] }),
      worksheetComponent: "A",
    };

    const stub2: TaxPartyTemplate = {
      key: "key-b",
      label: "Template B",
      supportedFrequencies: ["monthly"],
      computePeriod: () => ({
        start: "2026-01-01",
        end: "2026-01-31",
        due: "2026-02-15",
      }),
      defaultDueRule: () => ({ monthOffset: 1, day: 15 }),
      computeWorksheet: async () => ({ fields: {} }),
      fieldOwnership: {},
      mergeWorksheet: (current) => current,
      settingsSchema: [],
      scheduleConfigSchema: [],
      buildReferenceView: () => ({ tables: [] }),
      worksheetComponent: "B",
    };

    registerParty(stub1);
    registerParty(stub2);

    expect(getParty("key-a")).toBe(stub1);
    expect(getParty("key-b")).toBe(stub2);
  });
});
