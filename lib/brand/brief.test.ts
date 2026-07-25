import { describe, expect, it } from "vitest";
import { compileAgentBrief } from "./brief";
import { splitParagraphs } from "./guideIntros";
import { seedCanon } from "./seedCanon";

describe("compileAgentBrief", () => {
  it("includes the ethos intro, naming criteria, neverWords, the ≤5% rule, and ends with escalation rule", () => {
    const brief = compileAgentBrief(seedCanon);

    expect(brief).toContain(seedCanon.guideIntros?.ethos);
    for (const criterion of seedCanon.naming.criteria) {
      expect(brief).toContain(criterion);
    }
    for (const word of seedCanon.voice.neverWords) {
      expect(brief).toContain(word);
    }
    expect(brief).toContain("≤5%");
    expect(brief.trim().endsWith("escalate to founder")).toBe(true);
  });

  it("carries every guide introduction that has a brief section", () => {
    const brief = compileAgentBrief(seedCanon);

    // The narrative the guide shows and the narrative agents are handed are the
    // same strings — that's the point of routing both through resolveGuideIntro.
    for (const section of ["ethos", "voice", "visual"] as const) {
      for (const paragraph of splitParagraphs(seedCanon.guideIntros?.[section] ?? "")) {
        expect(brief).toContain(paragraph);
      }
    }
  });

  it("is deterministic across calls", () => {
    expect(compileAgentBrief(seedCanon)).toBe(compileAgentBrief(seedCanon));
  });
});
