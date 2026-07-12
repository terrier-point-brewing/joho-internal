import { describe, expect, it } from "vitest";
import { buildPutPayload, initialFormValues, isSensitivePresent } from "./identityForm";
import type { FieldSpec } from "./types";

const schema: FieldSpec[] = [
  { key: "contact_name", label: "Contact name", type: "text" },
  { key: "fein", label: "Federal EIN", type: "text", required: true },
  { key: "ssn", label: "SSN", type: "text", sensitive: true },
];

describe("initialFormValues", () => {
  it("blanks sensitive fields even when the masked payload reports them present", () => {
    const masked = { contact_name: "Jane Doe", fein: "12-3456789", ssn: "present" };
    expect(initialFormValues(schema, masked)).toEqual({
      contact_name: "Jane Doe",
      fein: "12-3456789",
      ssn: "",
    });
  });

  it("blanks sensitive fields when the masked payload reports them absent", () => {
    const masked = { contact_name: "Jane Doe", fein: "12-3456789", ssn: "absent" };
    expect(initialFormValues(schema, masked).ssn).toBe("");
  });

  it("defaults every field to an empty string when no profile has been saved yet", () => {
    expect(initialFormValues(schema, undefined)).toEqual({
      contact_name: "",
      fein: "",
      ssn: "",
    });
  });
});

describe("isSensitivePresent", () => {
  it("is true only for a sensitive field masked as present", () => {
    const masked = { ssn: "present" };
    expect(isSensitivePresent(schema[2], masked)).toBe(true);
  });

  it("is false for a sensitive field masked as absent", () => {
    expect(isSensitivePresent(schema[2], { ssn: "absent" })).toBe(false);
  });

  it("is false for a non-sensitive field regardless of masked value", () => {
    expect(isSensitivePresent(schema[0], { contact_name: "present" })).toBe(false);
  });

  it("is false when the masked payload is undefined", () => {
    expect(isSensitivePresent(schema[2], undefined)).toBe(false);
  });
});

describe("buildPutPayload", () => {
  it("restricts the payload to schema keys and trims values", () => {
    const values = { contact_name: "  Jane Doe  ", fein: "12-3456789", ssn: "", extra_field: "should not leak" };
    expect(buildPutPayload(schema, values)).toEqual({
      contact_name: "Jane Doe",
      fein: "12-3456789",
      ssn: "",
    });
  });

  it("sends a blank string for an untouched sensitive field, preserving the leave-unchanged contract", () => {
    const payload = buildPutPayload(schema, { contact_name: "Jane Doe", fein: "12-3456789", ssn: "" });
    expect(payload.ssn).toBe("");
  });

  it("defaults missing keys to an empty string", () => {
    expect(buildPutPayload(schema, {})).toEqual({ contact_name: "", fein: "", ssn: "" });
  });
});
