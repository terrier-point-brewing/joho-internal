import { describe, expect, it } from "vitest";
import { GUIDE_SECTIONS } from "./guideIntros";
import { SECTION_KEYS, sectionOf, sectionSchema } from "./canonSections";
import { seedCanon } from "./seedCanon";

describe("SECTION_KEYS", () => {
  it("gives every guide subtab at least one canon key", () => {
    for (const section of GUIDE_SECTIONS) {
      expect(SECTION_KEYS[section].length, `${section} owns no keys`).toBeGreaterThan(0);
    }
  });

  it("never lets two subtabs own the same key", () => {
    const seen = new Map<string, string>();
    for (const section of GUIDE_SECTIONS) {
      for (const key of SECTION_KEYS[section]) {
        expect(seen.has(key), `${key} owned by both ${seen.get(key)} and ${section}`).toBe(false);
        seen.set(key, section);
      }
    }
  });
});

describe("sectionSchema", () => {
  it("accepts a patch containing only the section's own keys", () => {
    const result = sectionSchema("ethos").safeParse({ values: seedCanon.values });
    expect(result.success).toBe(true);
  });

  it("does not carry a foreign key through into the parsed output", () => {
    const result = sectionSchema("ethos").safeParse({
      values: seedCanon.values,
      voice: seedCanon.voice,
    });
    // Zod object schemas strip unknown keys rather than rejecting them; what
    // matters is that a foreign key can never reach the merged document.
    expect(result.success).toBe(true);
    expect(result.success && "voice" in result.data).toBe(false);
  });

  it("rejects a patch whose own key is malformed", () => {
    const result = sectionSchema("ethos").safeParse({ values: "not an array" });
    expect(result.success).toBe(false);
  });

  it("validates the color section independently of the rest of the canon", () => {
    const result = sectionSchema("color").safeParse({
      palette: seedCanon.palette,
      roleMap: seedCanon.roleMap,
      usageRatios: seedCanon.usageRatios,
      colorForbidden: seedCanon.colorForbidden,
    });
    expect(result.success).toBe(true);
  });
});

describe("sectionOf", () => {
  it("maps an owned key back to its subtab", () => {
    expect(sectionOf("palette")).toBe("color");
    expect(sectionOf("values")).toBe("ethos");
    expect(sectionOf("fonts")).toBe("type");
    expect(sectionOf("hardRules")).toBe("agent");
  });

  it("returns null for a key no subtab owns", () => {
    expect(sectionOf("naming")).toBeNull();
    expect(sectionOf("visibility")).toBeNull();
    expect(sectionOf("brandName")).toBeNull();
  });
});
