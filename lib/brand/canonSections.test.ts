import { describe, expect, it } from "vitest";
import { GUIDE_SECTIONS } from "./guideIntros";
import {
  SECTION_KEYS,
  changedSections,
  isSectionDirty,
  pickSectionPatch,
  sectionOf,
  sectionSchema,
} from "./canonSections";
import { seedCanon } from "./seedCanon";
import type { BrandCanon } from "./canon.types";

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

describe("pickSectionPatch", () => {
  it("carries only the section's keys plus its own intro", () => {
    const patch = pickSectionPatch(seedCanon, "ethos");

    expect(Object.keys(patch).sort()).toEqual(["guideIntros", "values"]);
    expect(Object.keys(patch.guideIntros!)).toEqual(["ethos"]);
  });

  it("never carries another subtab's intro", () => {
    const patch = pickSectionPatch(seedCanon, "color");
    expect(patch.guideIntros).toEqual({ color: seedCanon.guideIntros?.color });
  });

  it("carries all four color keys", () => {
    const patch = pickSectionPatch(seedCanon, "color");
    expect(Object.keys(patch).sort()).toEqual([
      "colorForbidden",
      "guideIntros",
      "palette",
      "roleMap",
      "usageRatios",
    ]);
  });

  it("omits an absent optional key rather than sending undefined", () => {
    const noMarks: BrandCanon = { ...seedCanon };
    delete noMarks.marks;
    expect("marks" in pickSectionPatch(noMarks, "marks")).toBe(false);
  });
});

describe("isSectionDirty / changedSections", () => {
  const base = seedCanon;

  it("reports a section clean against itself", () => {
    expect(isSectionDirty(base, structuredClone(base), "ethos")).toBe(false);
    expect(changedSections(base, structuredClone(base))).toEqual([]);
  });

  it("flags only the section that actually changed", () => {
    const next = structuredClone(base);
    next.values[0].title = "Changed";

    expect(isSectionDirty(base, next, "ethos")).toBe(true);
    expect(isSectionDirty(base, next, "voice")).toBe(false);
    expect(changedSections(base, next)).toEqual(["ethos"]);
  });

  it("flags a section whose intro changed even when its keys did not", () => {
    const next = structuredClone(base);
    next.guideIntros = { ...next.guideIntros, voice: "A new voice introduction." };

    expect(isSectionDirty(base, next, "voice")).toBe(true);
    expect(changedSections(base, next)).toEqual(["voice"]);
  });

  it("reports several changed sections at once", () => {
    const next = structuredClone(base);
    next.values[0].title = "Changed";
    next.palette[0].hex = "#111111";
    next.hardRules = [...next.hardRules, "A new rule"];

    expect(changedSections(base, next).sort()).toEqual(["agent", "color", "ethos"]);
  });

  it("ignores a change to a key no subtab owns", () => {
    const next = structuredClone(base);
    next.naming = { ...next.naming, pattern: "Something else" };

    expect(changedSections(base, next)).toEqual([]);
  });

  it("treats a null document as not dirty rather than throwing", () => {
    expect(isSectionDirty(null, base, "ethos")).toBe(false);
    expect(changedSections(undefined, base)).toEqual([]);
  });
});

describe("section ownership covers every editable key", () => {
  it("lets the type section write its use cases", () => {
    // Regression: typeUseCases was added to the schema and the editor before
    // SECTION_KEYS knew about it, so saveDraftSection would have rejected every
    // use-case edit with "section type may not write typeUseCases".
    expect(SECTION_KEYS.type).toContain("typeUseCases");
    expect(sectionOf("typeUseCases")).toBe("type");
  });

  it("carries typeUseCases in a type section patch", () => {
    const patch = pickSectionPatch(
      { ...seedCanon, typeUseCases: [] },
      "type",
    );
    expect("typeUseCases" in patch).toBe(true);
  });
});
