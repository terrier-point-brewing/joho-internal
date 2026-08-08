import { describe, expect, it } from "vitest";
import { normalizePairs } from "./rulePairs";
import { seedCanon } from "./seedCanon";

describe("normalizePairs", () => {
  it("returns an empty list when there is no law at all", () => {
    expect(normalizePairs(undefined)).toEqual([]);
    expect(normalizePairs({})).toEqual([]);
  });

  it("passes stored pairs through untouched", () => {
    const pairs = [
      {
        id: "p1",
        title: "Clean vector logic",
        do: { caption: "Every shape explainable.", brief: "Clean railing" },
        dont: { caption: "AI-artifact incoherence.", brief: "Melting railing" },
        nuance: "Broken geometry reads as carelessness.",
      },
    ];
    expect(normalizePairs({ pairs })).toEqual(pairs);
  });

  it("folds a legacy do-rule onto the do side, leaving the don't blank", () => {
    const [pair] = normalizePairs({
      rules: [
        {
          id: "r1",
          polarity: "do",
          title: "Figures stay small",
          detail: "Distance keeps the scene theirs.",
          caption: "Two silhouettes under lantern light",
          assetId: "asset-1",
        },
      ],
    });

    expect(pair.title).toBe("Figures stay small");
    expect(pair.do).toEqual({
      caption: "Figures stay small",
      // A legacy caption describes the artwork, so it is a brief, not a caption.
      brief: "Two silhouettes under lantern light",
      assetId: "asset-1",
    });
    expect(pair.dont).toEqual({});
    expect(pair.nuance).toBe("Distance keeps the scene theirs.");
  });

  it("folds a legacy don't-rule onto the don't side", () => {
    const [pair] = normalizePairs({
      rules: [{ id: "r1", polarity: "dont", title: "No photorealism" }],
    });

    expect(pair.dont.caption).toBe("No photorealism");
    expect(pair.do).toEqual({});
  });

  it("folds bare legacy strings, which have no polarity, onto the do side", () => {
    const [pair] = normalizePairs({ rules: ["Flat two-colour line work."] });
    expect(pair.do.caption).toBe("Flat two-colour line work.");
  });

  it("prefers pairs over a legacy list left beside them", () => {
    const pairs = [{ id: "p1", title: "Pairs win", do: {}, dont: {} }];
    const out = normalizePairs({ pairs, rules: ["stale"] });
    expect(out).toEqual(pairs);
  });

  it("derives STABLE ids when folding, so React keys and diffs hold still", () => {
    // A random id here would differ on every render, and diffCanon would report
    // the whole list as replaced on every publish.
    const law = { rules: ["a", "b"] };
    expect(normalizePairs(law).map((p) => p.id)).toEqual(normalizePairs(law).map((p) => p.id));
  });

  it("keeps a legacy rule's own id, so it survives the fold", () => {
    expect(normalizePairs({ rules: [{ id: "r1", polarity: "do", title: "x" }] })[0].id).toBe("r1");
  });
});

describe("the seeded visual identity law", () => {
  const pairs = seedCanon.illustrationLaw.pairs ?? [];

  it("is seven pairs", () => {
    expect(pairs).toHaveLength(7);
  });

  it("gives every rule BOTH halves and a reason", () => {
    // The whole point of the pairing: a rule with one empty side is a rule
    // whose failure case nobody wrote down.
    for (const pair of pairs) {
      expect(pair.title, `${pair.title}: title`).toBeTruthy();
      expect(pair.do.caption, `${pair.title}: do caption`).toBeTruthy();
      expect(pair.dont.caption, `${pair.title}: dont caption`).toBeTruthy();
      expect(pair.nuance, `${pair.title}: nuance`).toBeTruthy();
    }
  });

  it("briefs both image slots, since none of the artwork exists yet", () => {
    for (const pair of pairs) {
      expect(pair.do.brief, `${pair.title}: do brief`).toBeTruthy();
      expect(pair.dont.brief, `${pair.title}: dont brief`).toBeTruthy();
    }
  });

  it("has retired style homage — no seed line, and no card standing in for one", () => {
    expect("homage" in seedCanon.illustrationLaw).toBe(false);
    expect(pairs.some((p) => p.title.toLowerCase().includes("homage"))).toBe(false);
  });
});
