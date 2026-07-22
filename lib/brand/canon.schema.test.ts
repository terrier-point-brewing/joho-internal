import { describe, expect, it } from "vitest";
import { canonSchema } from "./canon.schema";
import { seedCanon } from "./seedCanon";

describe("canonSchema", () => {
  it("parses seedCanon successfully", () => {
    expect(() => canonSchema.parse(seedCanon)).not.toThrow();
  });

  it("throws when a required field (mission) is missing", () => {
    const { mission: _mission, ...malformed } = seedCanon;
    expect(() => canonSchema.parse(malformed)).toThrow();
  });

  it("throws when a palette hex is malformed", () => {
    const malformed = {
      ...seedCanon,
      palette: [{ ...seedCanon.palette[0], hex: "not-a-hex" }, ...seedCanon.palette.slice(1)],
    };
    expect(() => canonSchema.parse(malformed)).toThrow();
  });
});
