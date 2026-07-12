import { describe, it, expect } from "vitest";
import { parseFinancialsParams } from "./parseParams";

describe("parseFinancialsParams", () => {
  it("missing statement -> ok:false", () => {
    const result = parseFinancialsParams(new URLSearchParams({ year: "2026" }));
    expect(result.ok).toBe(false);
  });

  it("invalid statement -> ok:false", () => {
    const result = parseFinancialsParams(new URLSearchParams({ statement: "income_statement", year: "2026" }));
    expect(result.ok).toBe(false);
  });

  it("missing year -> ok:false", () => {
    const result = parseFinancialsParams(new URLSearchParams({ statement: "pl" }));
    expect(result.ok).toBe(false);
  });

  it("non-numeric year -> ok:false", () => {
    const result = parseFinancialsParams(new URLSearchParams({ statement: "pl", year: "abc" }));
    expect(result.ok).toBe(false);
  });

  it("non-integer year -> ok:false", () => {
    const result = parseFinancialsParams(new URLSearchParams({ statement: "pl", year: "2026.5" }));
    expect(result.ok).toBe(false);
  });

  it("out-of-range year -> ok:false", () => {
    const result = parseFinancialsParams(new URLSearchParams({ statement: "pl", year: "1899" }));
    expect(result.ok).toBe(false);
  });

  it("valid pl params -> ok:true with parsed values", () => {
    const result = parseFinancialsParams(new URLSearchParams({ statement: "pl", year: "2026" }));
    expect(result).toEqual({ ok: true, statement: "pl", year: 2026 });
  });

  it("valid balance_sheet params -> ok:true", () => {
    const result = parseFinancialsParams(new URLSearchParams({ statement: "balance_sheet", year: "2025" }));
    expect(result).toEqual({ ok: true, statement: "balance_sheet", year: 2025 });
  });

  it("valid cash_flow params -> ok:true", () => {
    const result = parseFinancialsParams(new URLSearchParams({ statement: "cash_flow", year: "2024" }));
    expect(result).toEqual({ ok: true, statement: "cash_flow", year: 2024 });
  });
});
