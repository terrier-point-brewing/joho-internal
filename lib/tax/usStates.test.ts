import { describe, it, expect } from "vitest";
import { US_STATES } from "./usStates";
import { IDENTITY_SCHEMA } from "./identity";

describe("shared identity extension", () => {
  it("US_STATES includes NC and is 52 entries", () => {
    expect(US_STATES.find((s) => s.value === "NC")?.label).toBe("North Carolina");
    expect(US_STATES).toHaveLength(52);
  });
  it("IDENTITY_SCHEMA carries business-identity fields", () => {
    const keys = IDENTITY_SCHEMA.map((f) => f.key);
    for (const k of ["legal_name","trade_name","mailing_address","city","state","zip"]) expect(keys).toContain(k);
    expect(IDENTITY_SCHEMA.find((f) => f.key === "state")?.type).toBe("select");
  });
});
