// lib/production/bulkCanVariationNaming.test.ts
import { describe, it, expect } from "vitest";
import { buildCanSizeLabel, buildCanVariationName } from "./bulkCanVariationNaming";

describe("buildCanSizeLabel", () => {
  it("strips a trailing 'Blank' token", () => {
    expect(buildCanSizeLabel("16oz Blank")).toBe("16oz");
  });

  it("is case-insensitive", () => {
    expect(buildCanSizeLabel("16oz BLANK")).toBe("16oz");
    expect(buildCanSizeLabel("16oz blank")).toBe("16oz");
  });

  it("trims extra whitespace before the stripped token", () => {
    expect(buildCanSizeLabel("16oz   Blank")).toBe("16oz");
  });

  it("falls back to the full name when there is no trailing 'Blank' token", () => {
    expect(buildCanSizeLabel("16oz")).toBe("16oz");
  });

  it("falls back to the full trimmed name when the name is only 'Blank'", () => {
    expect(buildCanSizeLabel("Blank")).toBe("Blank");
  });

  it("does not strip 'Blank' in the middle of the name", () => {
    expect(buildCanSizeLabel("Blank 16oz")).toBe("Blank 16oz");
  });
});

describe("buildCanVariationName", () => {
  const common = { baseName: "CBC Pumpkin Reaper Ale", containerName: "16oz Blank" };

  it("builds the loose (base) labeled-can name", () => {
    expect(buildCanVariationName({ ...common, format: "loose", isLabeled: true })).toBe(
      "CBC Pumpkin Reaper Ale - 16oz Labeled Can"
    );
  });

  it("builds the 4-pack labeled-can name", () => {
    expect(buildCanVariationName({ ...common, format: "4-pack", isLabeled: true })).toBe(
      "CBC Pumpkin Reaper Ale - 16oz Labeled Can 4-Pack"
    );
  });

  it("builds the 6-pack labeled-can name", () => {
    expect(buildCanVariationName({ ...common, format: "6-pack", isLabeled: true })).toBe(
      "CBC Pumpkin Reaper Ale - 16oz Labeled Can 6-Pack"
    );
  });

  it("builds the case labeled-can name", () => {
    expect(buildCanVariationName({ ...common, format: "case", isLabeled: true })).toBe(
      "CBC Pumpkin Reaper Ale - 16oz Labeled Can Case"
    );
  });

  it("builds the loose printed-can name when isLabeled is false", () => {
    expect(buildCanVariationName({ ...common, format: "loose", isLabeled: false })).toBe(
      "CBC Pumpkin Reaper Ale - 16oz Printed Can"
    );
  });

  it("builds the case printed-can name when isLabeled is false", () => {
    expect(buildCanVariationName({ ...common, format: "case", isLabeled: false })).toBe(
      "CBC Pumpkin Reaper Ale - 16oz Printed Can Case"
    );
  });
});
