import { describe, it, expect } from "vitest";
import {
  monthEnd,
  validateManualEntry,
  type ManualEntryInput,
  type ValidationResult,
} from "./manualEntries";

/** Build an input that deliberately violates the discriminated union (extra/missing fields). */
function loose(obj: Record<string, unknown>): ManualEntryInput {
  return obj as unknown as ManualEntryInput;
}

function expectInvalid(input: ManualEntryInput, field: RegExp): void {
  const result: ValidationResult = validateManualEntry(input);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatch(field);
}

const COA = "11111111-1111-4111-8111-111111111111";

const validFlow: ManualEntryInput = {
  entryKind: "flow",
  chartOfAccountsId: COA,
  startDate: "2026-07-01",
  endDate: "2026-07-31",
  amountCents: 125_00,
};

const validBalance: ManualEntryInput = {
  entryKind: "balance",
  chartOfAccountsId: COA,
  asOfDate: "2026-07-31",
  amountCents: 125_00,
};

describe("validateManualEntry — rejects", () => {
  it("rejects an unknown entryKind", () => {
    expectInvalid(loose({ ...validFlow, entryKind: "snapshot" }), /entryKind/);
  });

  it("rejects a missing chartOfAccountsId", () => {
    expectInvalid(loose({ ...validFlow, chartOfAccountsId: "" }), /chartOfAccountsId/);
  });

  it("rejects a flow missing endDate", () => {
    expectInvalid(loose({ ...validFlow, endDate: undefined }), /endDate/);
  });

  it("rejects a flow missing startDate", () => {
    expectInvalid(loose({ ...validFlow, startDate: undefined }), /startDate/);
  });

  it("rejects a flow whose startDate is after endDate", () => {
    expectInvalid(
      { ...validFlow, startDate: "2026-07-31", endDate: "2026-07-01" } as ManualEntryInput,
      /startDate/,
    );
  });

  it("rejects a flow carrying asOfDate", () => {
    expectInvalid(loose({ ...validFlow, asOfDate: "2026-07-31" }), /asOfDate/);
  });

  it("rejects a flow with a malformed date", () => {
    expectInvalid(loose({ ...validFlow, endDate: "07/31/2026" }), /endDate/);
  });

  it("rejects a balance carrying startDate", () => {
    expectInvalid(loose({ ...validBalance, startDate: "2026-07-01" }), /startDate/);
  });

  it("rejects a balance carrying endDate", () => {
    expectInvalid(loose({ ...validBalance, endDate: "2026-07-31" }), /endDate/);
  });

  it("rejects a balance missing asOfDate", () => {
    expectInvalid(loose({ ...validBalance, asOfDate: undefined }), /asOfDate/);
  });

  it("rejects a balance whose asOfDate is not a month end", () => {
    expectInvalid({ ...validBalance, asOfDate: "2026-07-15" } as ManualEntryInput, /asOfDate/);
  });

  it("rejects a balance on Feb 29 of a non-leap year (not a real month end)", () => {
    expectInvalid({ ...validBalance, asOfDate: "2026-02-29" } as ManualEntryInput, /asOfDate/);
  });

  it("rejects amountCents of zero", () => {
    expectInvalid({ ...validFlow, amountCents: 0 } as ManualEntryInput, /amountCents/);
    expectInvalid({ ...validBalance, amountCents: 0 } as ManualEntryInput, /amountCents/);
  });

  it("rejects amountCents of negative zero", () => {
    expectInvalid({ ...validFlow, amountCents: -0 } as ManualEntryInput, /amountCents/);
  });

  it("rejects a non-integer amountCents", () => {
    expectInvalid({ ...validFlow, amountCents: 125.5 } as ManualEntryInput, /amountCents/);
    expectInvalid(loose({ ...validFlow, amountCents: Number.NaN }), /amountCents/);
    expectInvalid(loose({ ...validFlow, amountCents: "1200" }), /amountCents/);
  });
});

describe("validateManualEntry — accepts", () => {
  it("accepts a well-formed flow", () => {
    expect(validateManualEntry(validFlow)).toEqual({ ok: true });
  });

  it("accepts a flow spanning a single day (startDate === endDate)", () => {
    expect(
      validateManualEntry({ ...validFlow, startDate: "2026-07-04", endDate: "2026-07-04" }),
    ).toEqual({ ok: true });
  });

  it("accepts a well-formed balance on a month end", () => {
    expect(validateManualEntry(validBalance)).toEqual({ ok: true });
  });

  it("accepts a balance with a negative amountCents (contra- and credit-side accounts)", () => {
    expect(validateManualEntry({ ...validBalance, amountCents: -250_00 })).toEqual({ ok: true });
  });

  it("accepts a flow with a negative amountCents (corrections)", () => {
    expect(validateManualEntry({ ...validFlow, amountCents: -250_00 })).toEqual({ ok: true });
  });

  it("accepts explicit nulls for the fields the other kind owns", () => {
    expect(validateManualEntry(loose({ ...validFlow, asOfDate: null }))).toEqual({ ok: true });
    expect(
      validateManualEntry(loose({ ...validBalance, startDate: null, endDate: null })),
    ).toEqual({ ok: true });
  });

  it("accepts optional label and note", () => {
    expect(validateManualEntry({ ...validFlow, label: "Taproom net sales", note: null })).toEqual({
      ok: true,
    });
  });

  it("accepts a leap-day month end", () => {
    expect(validateManualEntry({ ...validBalance, asOfDate: "2024-02-29" })).toEqual({ ok: true });
  });
});

describe("monthEnd", () => {
  it("returns the last day of a 31-day month", () => {
    expect(monthEnd("2026-01-15")).toBe("2026-01-31");
  });

  it("returns Feb 29 in a leap year", () => {
    expect(monthEnd("2024-02-01")).toBe("2024-02-29");
  });

  it("returns Feb 28 in a non-leap year", () => {
    expect(monthEnd("2026-02-10")).toBe("2026-02-28");
  });

  it("handles December without rolling into the next year", () => {
    expect(monthEnd("2026-12-05")).toBe("2026-12-31");
  });

  it("is idempotent on a date that is already a month end", () => {
    expect(monthEnd("2026-07-31")).toBe("2026-07-31");
    expect(monthEnd(monthEnd("2026-04-02"))).toBe("2026-04-30");
  });

  it("returns a 30-day month end", () => {
    expect(monthEnd("2026-09-09")).toBe("2026-09-30");
  });
});
