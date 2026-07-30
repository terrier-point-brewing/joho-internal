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

describe("compileAgentBrief with illustrated rules", () => {
  it("renders rich rules as text, never [object Object]", () => {
    // Regression: colorForbidden and illustrationLaw.rules widened to accept
    // GuideRule objects in phase 2. Template-literal interpolation accepts any
    // type, so typecheck cannot catch this — only an assertion can.
    const canon = {
      ...seedCanon,
      colorForbidden: [
        { id: "f1", polarity: "dont" as const, title: "No pure black", detail: "Use Indigo." },
      ],
      illustrationLaw: {
        rules: [{ id: "v1", polarity: "dont" as const, title: "No drop shadows" }],
      },
    };

    const brief = compileAgentBrief(canon);

    expect(brief).not.toContain("[object Object]");
    expect(brief).toContain("No pure black — Use Indigo.");
    expect(brief).toContain("NEVER: No drop shadows");
  });

  it("still renders legacy string rules", () => {
    const brief = compileAgentBrief({
      ...seedCanon,
      colorForbidden: ["Pure black anywhere."],
      illustrationLaw: { rules: ["Flat two-colour line work."] },
    });

    expect(brief).toContain("Forbidden: Pure black anywhere.");
    expect(brief).toContain("ALWAYS: Flat two-colour line work.");
  });
});
