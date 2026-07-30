import type { BrandCanon, RoleName } from "@/lib/brand/canon.types";
import { resolveGuideIntro } from "@/lib/brand/guideIntros";
import { normalizeRules } from "@/lib/brand/guideRules";
import ColorSwatch from "./ColorSwatch";
import GuideSection from "./GuideSection";
import SubHead from "./blocks/SubHead";
import RuleGrid from "./blocks/RuleGrid";

// Explicit literal classNames (not template-string interpolation) so Tailwind's
// content scanner picks up every bg-brand-<role> utility. Order = display order.
const ROLE_SWATCHES: { role: RoleName; className: string }[] = [
  { role: "canvas", className: "bg-brand-canvas" },
  { role: "surface", className: "bg-brand-surface" },
  { role: "surface-raised", className: "bg-brand-surface-raised" },
  { role: "primary", className: "bg-brand-primary" },
  { role: "on-primary", className: "bg-brand-on-primary" },
  { role: "secondary", className: "bg-brand-secondary" },
  { role: "accent", className: "bg-brand-accent" },
  { role: "on-accent", className: "bg-brand-on-accent" },
  { role: "high-contrast", className: "bg-brand-high-contrast" },
  { role: "content", className: "bg-brand-content" },
  { role: "content-muted", className: "bg-brand-content-muted" },
  { role: "line", className: "bg-brand-line" },
  { role: "line-strong", className: "bg-brand-line-strong" },
];

/** Color view: the resolved role palette (display order) + forbidden list. */
export default function ColorView({ canon }: { canon: BrandCanon }) {
  const paletteByKey = new Map(canon.palette.map((c) => [c.key, c]));
  const ratioByRole = new Map(canon.usageRatios.map((r) => [r.role, r]));
  // Legacy entries are bare strings and are all prohibitions by definition.
  const forbidden = normalizeRules(canon.colorForbidden, "dont");

  return (
    <GuideSection intro={resolveGuideIntro(canon, "color")}>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
        {ROLE_SWATCHES.map(({ role, className }) => {
          const key = canon.roleMap.light[role];
          const color = paletteByKey.get(key);
          // Same resolution as lib/brand/tokens.ts's resolveLight: the role
          // value is either a palette key (resolve to its hex) or a raw hex.
          const hex = color?.hex ?? key;
          const ratio = ratioByRole.get(role);
          return (
            <ColorSwatch
              key={role}
              label={role}
              swatchName={color?.name ?? key}
              hex={hex}
              swatchClassName={className}
              pct={ratio?.pct}
            />
          );
        })}
      </div>
      {/* Forbidden combinations, as illustrated rules rather than a tiny list.
          "Seal Red on Indigo vibrates" is a claim you have to take on trust
          until you see it, so each rule carries an image slot. */}
      {forbidden.length > 0 && (
        <div className="mt-8">
          <SubHead
            title="Forbidden"
            description="Combinations that must never ship. Each one fails a review on its own."
          />
          <RuleGrid rules={forbidden} />
        </div>
      )}
    </GuideSection>
  );
}
