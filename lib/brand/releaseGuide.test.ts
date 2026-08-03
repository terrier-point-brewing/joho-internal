import { describe, expect, it } from "vitest";
import type { BrandCanon } from "./canon.types";
import { seedCanon } from "./seedCanon";
import { isEmptyGuideEntry, resolveReleaseGuide } from "./releaseGuide";

describe("resolveReleaseGuide", () => {
  const guide = resolveReleaseGuide(seedCanon);

  it("gives the Release Card the naming gates and the template's four slots", () => {
    expect(guide.card.rules).toEqual(seedCanon.naming.criteria);
    expect(guide.card.intro).toBe(seedCanon.naming.narrative.intro);
    expect(guide.card.footer).toBe(seedCanon.naming.narrative.footer);
    expect(guide.card.rows.map((r) => r.label)).toEqual([
      "Name",
      "Story line",
      "Menu description",
      "Why it passes",
    ]);
  });

  it("gives the Label the chassis narrative and its elements, in reading order", () => {
    expect(guide.label.intro).toBe(seedCanon.labelChassis.narrative);
    expect(guide.label.rows).toHaveLength(seedCanon.labelChassis.elements.length);
    const ns = guide.label.rows.map((r) => Number(r.label.split(".")[0]));
    expect(ns).toEqual([...ns].sort((a, b) => a - b));
  });

  it("leaves Beer Recipe and Product Codes empty — the guide doesn't govern them", () => {
    expect(isEmptyGuideEntry(guide.recipe)).toBe(true);
    expect(isEmptyGuideEntry(guide.codes)).toBe(true);
  });

  it("drops template slots the canon hasn't written rather than showing a bare label", () => {
    const partial = {
      ...seedCanon,
      naming: {
        ...seedCanon.naming,
        narrative: { ...seedCanon.naming.narrative, story: "", why: "" },
      },
    } as BrandCanon;
    expect(resolveReleaseGuide(partial).card.rows.map((r) => r.label)).toEqual([
      "Name",
      "Menu description",
    ]);
  });

  it("survives a canon missing the slices entirely", () => {
    // getCanon() deliberately doesn't validate on read, so a document published
    // before a field existed reaches the resolver with holes in it.
    const bare = {} as BrandCanon;
    const resolved = resolveReleaseGuide(bare);
    expect(resolved.card).toEqual({ intro: "", rules: [], rows: [], footer: "" });
    expect(isEmptyGuideEntry(resolved.label)).toBe(true);
  });
});

describe("isEmptyGuideEntry", () => {
  it("ignores a footer with nothing above it", () => {
    expect(isEmptyGuideEntry({ intro: "", rules: [], rows: [], footer: "Say it aloud." })).toBe(true);
  });

  it("is false once the guide says anything renderable", () => {
    expect(isEmptyGuideEntry({ intro: "A word.", rules: [], rows: [], footer: "" })).toBe(false);
    expect(isEmptyGuideEntry({ intro: "", rules: ["Ownable?"], rows: [], footer: "" })).toBe(false);
  });

  it("treats a missing entry as empty", () => {
    expect(isEmptyGuideEntry(undefined)).toBe(true);
  });
});
