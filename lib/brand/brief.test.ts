import { describe, expect, it } from "vitest";
import { compileAgentBrief } from "./brief";
import { seedCanon } from "./seedCanon";

describe("compileAgentBrief", () => {
  it("includes mission, naming criteria, neverWords, the ≤5% rule, and ends with escalation rule", () => {
    const brief = compileAgentBrief(seedCanon);

    expect(brief).toContain(seedCanon.mission);
    for (const criterion of seedCanon.naming.criteria) {
      expect(brief).toContain(criterion);
    }
    for (const word of seedCanon.voice.neverWords) {
      expect(brief).toContain(word);
    }
    expect(brief).toContain("≤5%");
    expect(brief.trim().endsWith("escalate to founder")).toBe(true);
  });

  it("is deterministic across calls", () => {
    expect(compileAgentBrief(seedCanon)).toBe(compileAgentBrief(seedCanon));
  });
});
