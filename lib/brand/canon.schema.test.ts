import { describe, expect, it } from "vitest";
import { canonSchema } from "./canon.schema";
import { seedCanon } from "./seedCanon";

describe("canonSchema", () => {
  it("parses seedCanon successfully", () => {
    expect(() => canonSchema.parse(seedCanon)).not.toThrow();
  });

  it("throws when a required field (brandName) is missing", () => {
    const { brandName: _brandName, ...malformed } = seedCanon;
    expect(() => canonSchema.parse(malformed)).toThrow();
  });

  it("parses a document with no guideIntros (published before the field existed)", () => {
    const { guideIntros: _guideIntros, ...legacy } = seedCanon;
    expect(() => canonSchema.parse(legacy)).not.toThrow();
  });

  it("throws when a palette hex is malformed", () => {
    const malformed = {
      ...seedCanon,
      palette: [{ ...seedCanon.palette[0], hex: "not-a-hex" }, ...seedCanon.palette.slice(1)],
    };
    expect(() => canonSchema.parse(malformed)).toThrow();
  });
});
