import type { z } from "zod";
import type { rulePairSchema } from "./canon.schema";
import type { BrandCanon } from "./canon.types";
import { normalizeRules } from "./guideRules";

/**
 * A Visual Identity rule and the failure it exists to prevent, side by side.
 *
 * The pairing is the point. Written as two independent columns, "flat vector
 * rendering" and "no photorealism" were the same rule stated twice, six bullets
 * apart, and a reader had to reconstruct the relationship themselves.
 */
export type RulePair = z.infer<typeof rulePairSchema>;
export type RulePanel = RulePair["do"];

/** The stored shape, which may still be the pre-pairing one. */
type StoredLaw = BrandCanon["illustrationLaw"] | undefined;

/**
 * Reads the illustration law as pairs, whatever shape it is stored in.
 *
 * getCanon() does not validate on read, and the brand migrations are
 * human-gated — so between a deploy and its migration the published document
 * still holds the flat `rules` list. Rather than render an empty subtab, a
 * legacy rule folds into a pair on the side its polarity names, leaving the
 * other side blank. That degrades honestly: the card shows exactly which half
 * of the pair has been authored, which is the prompt to finish it.
 *
 * The fold puts the rule's own text in BOTH the title and its panel caption.
 * It reads as a repeat, and that is the accurate rendering — a legacy rule is
 * one statement doing both jobs, and it stops the agent brief losing its
 * ALWAYS/NEVER line for a document that hasn't been re-authored yet. A legacy
 * `caption` describes the artwork, so it folds to `brief`, not to `caption`.
 *
 * Ids are DERIVED for folded rules, never random — a `crypto.randomUUID()` here
 * would change on every render, churning React keys and making diffCanon report
 * the whole list as replaced on every publish.
 */
export function normalizePairs(law: StoredLaw): RulePair[] {
  if (law?.pairs?.length) return law.pairs;

  return normalizeRules(law?.rules, "do").map((rule, index) => {
    const panel: RulePanel = {
      caption: rule.title,
      brief: rule.caption,
      assetId: rule.assetId,
    };
    return {
      id: rule.id ?? `legacy:${index}`,
      title: rule.title,
      do: rule.polarity === "do" ? panel : {},
      dont: rule.polarity === "dont" ? panel : {},
      nuance: rule.detail,
    };
  });
}
