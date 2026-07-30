import type { z } from "zod";
import type { guideRuleSchema } from "./canon.schema";

/**
 * One illustrated brand rule — the shared atom behind Visual Identity's
 * do/don't grid and the Color tab's forbidden list.
 */
export type GuideRule = z.infer<typeof guideRuleSchema>;

/** Either shape a stored rule list may hold mid-migration. */
export type StoredRule = string | GuideRule;

export type Polarity = GuideRule["polarity"];

/**
 * Upgrades a stored rule list to rich rules.
 *
 * Documents written before phase 2 hold bare strings, and `getCanon()` doesn't
 * validate on read — so the reader has to tolerate both shapes rather than the
 * schema rejecting one. Migration 20260904 rewrites stored rows; until then
 * (and for any row that misses it) this keeps the guide rendering.
 *
 * Legacy ids are DERIVED, not random. A `crypto.randomUUID()` here would return
 * a different id on every render, which would churn React keys and make
 * diffCanon report the whole list as replaced on every publish.
 */
export function normalizeRules(
  input: StoredRule[] | undefined,
  fallbackPolarity: Polarity,
): GuideRule[] {
  if (!input) return [];

  return input.map((rule, index) => {
    if (typeof rule !== "string") return rule;
    return {
      id: `legacy:${index}`,
      polarity: fallbackPolarity,
      title: rule,
    };
  });
}

/** Partitions rules into the two columns of a do/don't grid, preserving order. */
export function splitByPolarity(rules: GuideRule[]): { dos: GuideRule[]; donts: GuideRule[] } {
  return {
    dos: rules.filter((r) => r.polarity === "do"),
    donts: rules.filter((r) => r.polarity === "dont"),
  };
}
