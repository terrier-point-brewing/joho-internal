import { describe, it, expect } from "vitest";
import { canSubmitComplete, type CompleteFormState } from "./completeForm";

function form(overrides: Partial<CompleteFormState> = {}): CompleteFormState {
  return {
    confirmationNumber: "ABC123",
    amountPaidInput: "42.50",
    submittedOn: "2026-07-15",
    notes: "",
    ...overrides,
  };
}

describe("canSubmitComplete", () => {
  it("allows a fully filled-in form", () => {
    expect(canSubmitComplete(form())).toBe(true);
  });

  it("allows a zero amount (e.g. a no-liability filing)", () => {
    expect(canSubmitComplete(form({ amountPaidInput: "0" }))).toBe(true);
  });

  it("rejects a blank confirmation number", () => {
    expect(canSubmitComplete(form({ confirmationNumber: "" }))).toBe(false);
    expect(canSubmitComplete(form({ confirmationNumber: "   " }))).toBe(false);
  });

  it("rejects a blank submitted-on date", () => {
    expect(canSubmitComplete(form({ submittedOn: "" }))).toBe(false);
  });

  it("rejects a blank amount", () => {
    expect(canSubmitComplete(form({ amountPaidInput: "" }))).toBe(false);
  });

  it("rejects a non-numeric amount", () => {
    expect(canSubmitComplete(form({ amountPaidInput: "abc" }))).toBe(false);
  });

  it("rejects a negative amount", () => {
    expect(canSubmitComplete(form({ amountPaidInput: "-5" }))).toBe(false);
  });

  it("does not require notes", () => {
    expect(canSubmitComplete(form({ notes: "" }))).toBe(true);
  });
});
