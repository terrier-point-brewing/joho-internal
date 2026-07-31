import type { BrandAsset } from "@/lib/brand/assets";
import type { BrandCanon } from "@/lib/brand/canon.types";
import { resolveGuideIntro } from "@/lib/brand/guideIntros";
import { normalizeRules } from "@/lib/brand/guideRules";
import GuideSection from "./GuideSection";
import RuleGrid from "./blocks/RuleGrid";

/**
 * Visual Identity view: the introduction, then the rules as a do/don't grid.
 *
 * These used to be six undifferentiated bullets that mixed what must be done
 * with what must never be done, appearing with no lead-in. Each is now a card
 * in the column that says which kind it is, with room for an image showing the
 * rule in practice.
 *
 * Legacy rules (bare strings) default to the "Do" column — historically these
 * were written as positive laws, and an admin can re-polarise any that aren't.
 */
export default function VisualIdentityView({
  canon,
  assetsById,
}: {
  canon: BrandCanon;
  /** Resolved assets, so illustrated rules can use their authored alt text. */
  assetsById?: Map<string, BrandAsset>;
}) {
  const rules = normalizeRules(canon.illustrationLaw?.rules, "do");

  return (
    <GuideSection intro={resolveGuideIntro(canon, "visual")}>
      <RuleGrid rules={rules} assetsById={assetsById} />
    </GuideSection>
  );
}
