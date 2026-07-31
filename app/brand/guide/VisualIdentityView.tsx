import type { BrandAsset } from "@/lib/brand/assets";
import type { BrandCanon } from "@/lib/brand/canon.types";
import { resolveGuideIntro } from "@/lib/brand/guideIntros";
import { normalizeRules } from "@/lib/brand/guideRules";
import GuideSection from "./GuideSection";
import RuleGrid from "./blocks/RuleGrid";
import SubHead from "./blocks/SubHead";
import SpecCard from "./blocks/SpecCard";

/**
 * Visual Identity view: the introduction, the rules as a do/don't grid, then the
 * label chassis.
 *
 * The rules used to be six undifferentiated bullets that mixed what must be done
 * with what must never be done, appearing with no lead-in. Each is now a card
 * in the column that says which kind it is, with room for an image showing the
 * rule in practice.
 *
 * Legacy rules (bare strings) default to the "Do" column — historically these
 * were written as positive laws, and an admin can re-polarise any that aren't.
 *
 * The chassis appears here for the first time in Phase A. It was stored in the
 * canon and rendered nowhere, which meant the one spec every beer label is built
 * against could not be read by anyone using the guide.
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
  const chassis = canon.labelChassis;
  const elements = chassis?.elements ?? [];

  return (
    <GuideSection intro={resolveGuideIntro(canon, "visual")}>
      <RuleGrid rules={rules} assetsById={assetsById} />

      {(chassis?.narrative || elements.length > 0) && (
        <section className="mt-8">
          <SubHead
            title="The label chassis"
            description="The fixed frame every release is poured into. The illustration roams; the chassis is home."
          />
          {chassis?.narrative && (
            <p className="font-brand-body text-sm text-brand-content leading-relaxed mb-4">
              {chassis.narrative}
            </p>
          )}
          {elements.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {elements.map((element, i) => (
                <SpecCard
                  key={i}
                  eyebrow={element.n}
                  title={element.title}
                  rows={[{ label: "Rule", value: element.desc }]}
                />
              ))}
            </div>
          )}
        </section>
      )}
    </GuideSection>
  );
}
