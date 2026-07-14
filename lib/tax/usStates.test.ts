import { describe, it, expect } from "vitest";
import { US_STATES } from "./usStates";

describe("US_STATES", () => {
  it("includes NC and is 52 entries", () => {
    expect(US_STATES.find((s) => s.value === "NC")?.label).toBe("North Carolina");
    expect(US_STATES).toHaveLength(52);
  });
  it("uses 2-letter codes as values and includes DC + PR", () => {
    expect(US_STATES.every((s) => /^[A-Z]{2}$/.test(s.value))).toBe(true);
    expect(US_STATES.find((s) => s.value === "DC")).toBeTruthy();
    expect(US_STATES.find((s) => s.value === "PR")).toBeTruthy();
  });
});
