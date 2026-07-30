import { describe, it, expect } from "vitest";
import { buildManualEntryPatch } from "./manualEntryPatch";
import type { ManualEntryRecord, ManualEntryInput } from "./manualEntries";

function record(overrides: Partial<ManualEntryRecord> = {}): ManualEntryRecord {
  return {
    id: "entry-1",
    entryKind: "flow",
    chartOfAccountsId: "coa-1",
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    asOfDate: null,
    amountCents: 10000,
    label: "Original",
    note: null,
    createdAt: "2026-01-01T00:00:00Z",
    createdBy: "user-1",
    updatedAt: "2026-01-01T00:00:00Z",
    updatedBy: "user-1",
    ...overrides,
  };
}

describe("buildManualEntryPatch", () => {
  it("no changes -> patch of just { id }", () => {
    const existing = record();
    const next: ManualEntryInput = {
      entryKind: "flow",
      chartOfAccountsId: "coa-1",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      amountCents: 10000,
      label: "Original",
    };
    expect(buildManualEntryPatch(existing, next)).toEqual({ id: "entry-1" });
  });

  it("amount-only change on a flow entry", () => {
    const existing = record();
    const next: ManualEntryInput = {
      entryKind: "flow",
      chartOfAccountsId: "coa-1",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      amountCents: 12000,
      label: "Original",
    };
    expect(buildManualEntryPatch(existing, next)).toEqual({ id: "entry-1", amountCents: 12000 });
  });

  it("date-range change on a flow entry patches only the changed date", () => {
    const existing = record();
    const next: ManualEntryInput = {
      entryKind: "flow",
      chartOfAccountsId: "coa-1",
      startDate: "2026-01-01",
      endDate: "2026-02-15",
      amountCents: 10000,
      label: "Original",
    };
    expect(buildManualEntryPatch(existing, next)).toEqual({ id: "entry-1", endDate: "2026-02-15" });
  });

  it("as-of-date change on a balance entry", () => {
    const existing = record({
      entryKind: "balance",
      startDate: null,
      endDate: null,
      asOfDate: "2026-01-31",
    });
    const next: ManualEntryInput = {
      entryKind: "balance",
      chartOfAccountsId: "coa-1",
      asOfDate: "2026-02-28",
      amountCents: 10000,
      label: "Original",
    };
    expect(buildManualEntryPatch(existing, next)).toEqual({ id: "entry-1", asOfDate: "2026-02-28" });
  });

  it("switching flow -> balance sends the new asOfDate and explicit nulls for start/end", () => {
    const existing = record();
    const next: ManualEntryInput = {
      entryKind: "balance",
      chartOfAccountsId: "coa-1",
      asOfDate: "2026-01-31",
      amountCents: 10000,
      label: "Original",
    };
    expect(buildManualEntryPatch(existing, next)).toEqual({
      id: "entry-1",
      entryKind: "balance",
      asOfDate: "2026-01-31",
      startDate: null,
      endDate: null,
    });
  });

  it("switching balance -> flow sends the new start/end and an explicit null for asOfDate", () => {
    const existing = record({
      entryKind: "balance",
      startDate: null,
      endDate: null,
      asOfDate: "2026-01-31",
    });
    const next: ManualEntryInput = {
      entryKind: "flow",
      chartOfAccountsId: "coa-1",
      startDate: "2026-02-01",
      endDate: "2026-02-28",
      amountCents: 10000,
      label: "Original",
    };
    expect(buildManualEntryPatch(existing, next)).toEqual({
      id: "entry-1",
      entryKind: "flow",
      startDate: "2026-02-01",
      endDate: "2026-02-28",
      asOfDate: null,
    });
  });

  it("chartOfAccountsId change is patched", () => {
    const existing = record();
    const next: ManualEntryInput = {
      entryKind: "flow",
      chartOfAccountsId: "coa-2",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      amountCents: 10000,
      label: "Original",
    };
    expect(buildManualEntryPatch(existing, next)).toEqual({ id: "entry-1", chartOfAccountsId: "coa-2" });
  });

  it("clearing the label patches label: null", () => {
    const existing = record();
    const next: ManualEntryInput = {
      entryKind: "flow",
      chartOfAccountsId: "coa-1",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      amountCents: 10000,
      label: null,
    };
    expect(buildManualEntryPatch(existing, next)).toEqual({ id: "entry-1", label: null });
  });
});
