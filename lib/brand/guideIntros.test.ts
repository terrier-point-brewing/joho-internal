import { describe, expect, it } from "vitest";
import type { BrandCanon } from "./canon.types";
import {
  GUIDE_SECTIONS,
  firstParagraph,
  resolveGuideIntro,
  splitParagraphs,
} from "./guideIntros";
import { seedCanon } from "./seedCanon";

const withIntros = (intros: BrandCanon["guideIntros"]): BrandCanon => ({
  ...seedCanon,
  guideIntros: intros,
});

describe("resolveGuideIntro", () => {
  it("returns the canon's own intro for every subtab", () => {
    for (const section of GUIDE_SECTIONS) {
      expect(resolveGuideIntro(seedCanon, section)).toBe(seedCanon.guideIntros?.[section]);
    }
  });

  it("prefers the canon's own intro over the seed", () => {
    const canon = withIntros({ ethos: "A newer ethos opening." });
    expect(resolveGuideIntro(canon, "ethos")).toBe("A newer ethos opening.");
  });

  it("falls back to the seed per subtab, so a document published before guideIntros existed still reads", () => {
    const { guideIntros: _guideIntros, ...legacy } = seedCanon;
    const canon = legacy as BrandCanon;
    for (const section of GUIDE_SECTIONS) {
      expect(resolveGuideIntro(canon, section)).toBe(seedCanon.guideIntros?.[section]);
    }
  });

  it("falls back per subtab, not all-or-nothing", () => {
    const canon = withIntros({ ethos: "Only ethos was edited." });
    expect(resolveGuideIntro(canon, "ethos")).toBe("Only ethos was edited.");
    expect(resolveGuideIntro(canon, "color")).toBe(seedCanon.guideIntros?.color);
  });

  it("treats a blank or whitespace-only intro as unset", () => {
    expect(resolveGuideIntro(withIntros({ ethos: "   \n  " }), "ethos")).toBe(
      seedCanon.guideIntros?.ethos,
    );
  });
});

describe("splitParagraphs", () => {
  it("splits on blank lines and trims", () => {
    expect(splitParagraphs("one\n\n  two  \n\n\nthree")).toEqual(["one", "two", "three"]);
  });

  it("keeps single newlines inside a paragraph", () => {
    expect(splitParagraphs("one\ntwo")).toEqual(["one\ntwo"]);
  });

  it("returns nothing for empty or whitespace-only text", () => {
    expect(splitParagraphs("")).toEqual([]);
    expect(splitParagraphs("  \n \n ")).toEqual([]);
  });
});

describe("firstParagraph", () => {
  it("returns only the opening paragraph of a multi-paragraph intro", () => {
    // The seeded voice intro is the old summary + personality, joined.
    const voice = resolveGuideIntro(seedCanon, "voice");
    expect(splitParagraphs(voice).length).toBe(2);
    expect(firstParagraph(seedCanon, "voice")).toBe(splitParagraphs(voice)[0]);
  });

  it("returns an empty string when the intro is empty", () => {
    expect(firstParagraph(withIntros({ ethos: "" }), "ethos")).toBe(
      splitParagraphs(seedCanon.guideIntros?.ethos ?? "")[0],
    );
  });
});
