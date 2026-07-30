import { describe, expect, it } from "vitest";
import { normalizeRules, splitByPolarity, type GuideRule } from "./guideRules";

describe("normalizeRules", () => {
  it("returns an empty list for undefined", () => {
    expect(normalizeRules(undefined, "do")).toEqual([]);
  });

  it("upgrades a legacy string to a rule with the fallback polarity", () => {
    const [rule] = normalizeRules(["No gradients anywhere."], "dont");

    expect(rule.polarity).toBe("dont");
    expect(rule.title).toBe("No gradients anywhere.");
    expect(rule.id).toBeTruthy();
    expect(rule.detail).toBeUndefined();
    expect(rule.assetId).toBeUndefined();
  });

  it("uses the given fallback polarity", () => {
    expect(normalizeRules(["Flat line work."], "do")[0].polarity).toBe("do");
  });

  it("derives a STABLE id for a legacy string", () => {
    // A random id here would differ on every render, breaking React keys and
    // making diffCanon report the whole list as replaced on each publish.
    const first = normalizeRules(["a", "b"], "do").map((r) => r.id);
    const second = normalizeRules(["a", "b"], "do").map((r) => r.id);
    expect(first).toEqual(second);
  });

  it("gives distinct legacy strings distinct ids", () => {
    const ids = normalizeRules(["a", "b", "c"], "do").map((r) => r.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("passes an already-rich rule through untouched", () => {
    const rich: GuideRule = {
      id: "r1",
      polarity: "dont",
      title: "Never stretch the chop",
      detail: "Scale uniformly only.",
      assetId: "asset-1",
      caption: "Stretched chop",
    };
    expect(normalizeRules([rich], "do")).toEqual([rich]);
  });

  it("handles a mixed list mid-migration", () => {
    const rich: GuideRule = { id: "r1", polarity: "do", title: "Rich" };
    const out = normalizeRules([rich, "legacy string"], "dont");

    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(rich);
    expect(out[1].polarity).toBe("dont");
    expect(out[1].title).toBe("legacy string");
  });

  it("is idempotent — normalizing its own output changes nothing", () => {
    const once = normalizeRules(["a", "b"], "do");
    expect(normalizeRules(once, "do")).toEqual(once);
  });
});

describe("splitByPolarity", () => {
  const rules: GuideRule[] = [
    { id: "1", polarity: "do", title: "Do this" },
    { id: "2", polarity: "dont", title: "Not this" },
    { id: "3", polarity: "do", title: "And this" },
  ];

  it("partitions rules into dos and donts", () => {
    const { dos, donts } = splitByPolarity(rules);
    expect(dos.map((r) => r.id)).toEqual(["1", "3"]);
    expect(donts.map((r) => r.id)).toEqual(["2"]);
  });

  it("preserves document order within each column", () => {
    const { dos } = splitByPolarity(rules);
    expect(dos[0].title).toBe("Do this");
  });

  it("handles an empty list", () => {
    expect(splitByPolarity([])).toEqual({ dos: [], donts: [] });
  });
});
