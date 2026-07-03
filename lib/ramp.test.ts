import { describe, it, expect } from "vitest";
import { extractGlAccount, toRampDatetime } from "./ramp";

describe("toRampDatetime", () => {
  it("expands a bare date to an RFC 3339 datetime (start vs end of day)", () => {
    expect(toRampDatetime("2026-01-01")).toBe("2026-01-01T00:00:00Z");
    expect(toRampDatetime("2026-12-31", true)).toBe("2026-12-31T23:59:59Z");
  });

  it("passes through a value that already has a time component", () => {
    expect(toRampDatetime("2026-01-01T09:30:00Z")).toBe("2026-01-01T09:30:00Z");
  });
});

describe("extractGlAccount", () => {
  it("pulls a GL account from transaction-level accounting_field_selections (category_info shape)", () => {
    const gl = extractGlAccount({
      accounting_field_selections: [
        { category_info: { id: "gl-1", external_id: "6000", name: "Marketing", type: "GL_ACCOUNT" } },
      ],
    });
    expect(gl).toEqual({ id: "gl-1", external_id: "6000", name: "Marketing" });
  });

  it("supports the flat (non-nested) selection shape", () => {
    const gl = extractGlAccount({
      accounting_field_selections: [
        { id: "gl-2", external_id: null, name: "Software", type: "GL_ACCOUNT" },
      ],
    });
    expect(gl).toEqual({ id: "gl-2", external_id: null, name: "Software" });
  });

  it("skips non-GL_ACCOUNT selections and finds the GL one", () => {
    const gl = extractGlAccount({
      accounting_field_selections: [
        { category_info: { id: "d-1", name: "Sales", type: "DEPARTMENT" } },
        { category_info: { id: "gl-3", name: "Travel", type: "GL_ACCOUNT" } },
      ],
    });
    expect(gl?.id).toBe("gl-3");
  });

  it("falls back to line-item selections when none at the top level", () => {
    const gl = extractGlAccount({
      accounting_field_selections: [],
      line_items: [
        { accounting_field_selections: [{ category_info: { id: "gl-4", name: "Utilities", type: "GL_ACCOUNT" } }] },
      ],
    });
    expect(gl?.id).toBe("gl-4");
  });

  it("uses external_id then name as the id when Ramp option id is absent", () => {
    expect(extractGlAccount({ accounting_field_selections: [{ external_id: "7000", name: "Rent", type: "GL_ACCOUNT" }] })?.id).toBe("7000");
    expect(extractGlAccount({ accounting_field_selections: [{ name: "Rent", type: "GL_ACCOUNT" }] })?.id).toBe("Rent");
  });

  it("returns null when uncoded or missing identifying info", () => {
    expect(extractGlAccount({})).toBeNull();
    expect(extractGlAccount({ accounting_field_selections: [{ type: "GL_ACCOUNT" }] })).toBeNull();
    expect(extractGlAccount({ accounting_field_selections: [{ category_info: { id: "x", name: "y", type: "DEPARTMENT" } }] })).toBeNull();
  });
});
