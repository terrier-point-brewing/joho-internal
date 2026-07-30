import type { BrandAsset } from "@/lib/brand/assets";
import type { BrandCanon, RoleName } from "@/lib/brand/canon.types";
import { resolveGuideIntro } from "@/lib/brand/guideIntros";
import { normalizeRules } from "@/lib/brand/guideRules";
import { resolveRole, rolesByPaletteKey } from "@/lib/brand/paletteLinks";
import { ROLE_NAMES, resolveDarkRoles, resolveLightRoles } from "@/lib/brand/tokens";
import GuideSection from "./GuideSection";
import SubHead from "./blocks/SubHead";
import SwatchCard from "./blocks/SwatchCard";
import RatioBar from "./blocks/RatioBar";
import RuleGrid from "./blocks/RuleGrid";

/** One row of the theme table: the role, and where each mode's value comes from. */
function ThemeRow({
  role,
  canon,
  lightHex,
  darkHex,
}: {
  role: RoleName;
  canon: BrandCanon;
  lightHex: string;
  darkHex: string;
}) {
  const light = resolveRole(canon, "light", role);
  const dark = resolveRole(canon, "dark", role);

  const source = (
    bound: { key: string | null; detached: boolean } | null,
    hex: string,
  ) => (
    <span className="flex items-center gap-2 min-w-0">
      <span
        className="h-4 w-4 shrink-0 rounded border border-brand-line"
        style={{ background: hex }}
      />
      {bound?.key ? (
        <span className="font-brand-body text-xs text-brand-content truncate">
          ← {canon.palette.find((c) => c.key === bound.key)?.name ?? bound.key}
        </span>
      ) : bound?.detached ? (
        <span className="font-brand-body text-xs text-brand-accent truncate">
          detached {hex}
        </span>
      ) : (
        // No stored value — computed at render time from the light role. Show
        // WHAT it derived to: a bare "derived" tells a reader nothing they can
        // act on, and it's the state a stale cache produces, so it needs to be
        // legible rather than mysterious.
        <span className="font-brand-body text-xs text-brand-content-muted truncate">
          derived {hex}
        </span>
      )}
    </span>
  );

  return (
    <div className="grid grid-cols-[8rem_1fr_1fr] items-center gap-3 px-3 py-2 border-b border-brand-line last:border-0">
      <span className="font-brand-body text-xs text-brand-high-contrast truncate">{role}</span>
      {source(light, lightHex)}
      {source(dark, darkHex)}
    </div>
  );
}

/**
 * Color view: the palette (the ink deck), the theme (what binds to it), the
 * usage ratios, and the forbidden combinations.
 *
 * Palette and theme are shown as two halves of one relationship rather than two
 * unrelated lists: each swatch says which roles it drives, and each role says
 * which color it came from. That link was previously invisible in the guide and
 * only half-visible in the editor.
 */
export default function ColorView({
  canon,
  assetsById,
}: {
  canon: BrandCanon;
  /** Resolved assets, so illustrated rules can use their authored alt text. */
  assetsById?: Map<string, BrandAsset>;
}) {
  const lightRoles = resolveLightRoles(canon);
  const darkRoles = resolveDarkRoles(canon, lightRoles);
  const drivesLight = rolesByPaletteKey(canon, "light");
  const drivesDark = rolesByPaletteKey(canon, "dark");
  const forbidden = normalizeRules(canon.colorForbidden, "dont");

  // Core first, then neutrals. Entries predating the tier split fall in with
  // the neutrals, which is where all four of them belong.
  const core = canon.palette.filter((c) => c.tier === "core");
  const neutrals = canon.palette.filter((c) => c.tier !== "core");

  const drivesFor = (key: string): RoleName[] => [
    ...(drivesLight.get(key) ?? []),
    ...(drivesDark.get(key) ?? []).filter((r) => !(drivesLight.get(key) ?? []).includes(r)),
  ];

  const groups = [
    { key: "core", title: "Core", colors: core },
    { key: "neutral", title: "Neutrals", colors: neutrals },
  ].filter((g) => g.colors.length > 0);

  return (
    <GuideSection intro={resolveGuideIntro(canon, "color")}>
      {groups.map((group) => (
        <section key={group.key} className="mb-8">
          <SubHead
            title={group.title}
            description={
              group.key === "core"
                ? "The brand's own colors. Everything else is built around these."
                : "UI steps and dark-mode grounds. Hand-authored, not computed."
            }
          />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {group.colors.map((color) => (
              <SwatchCard key={color.key} color={color} drives={drivesFor(color.key)} />
            ))}
          </div>
        </section>
      ))}

      <section className="mb-8">
        <SubHead
          title="Theme"
          description="Every surface binds to one of these thirteen roles. Each row shows the palette color behind it in each mode."
        />
        <div className="rounded-lg border border-brand-line overflow-hidden">
          <div className="grid grid-cols-[8rem_1fr_1fr] gap-3 px-3 py-2 border-b border-brand-line">
            <span className="font-brand-body text-2xs uppercase tracking-wide text-brand-content-muted">
              Role
            </span>
            <span className="font-brand-body text-2xs uppercase tracking-wide text-brand-content-muted">
              Light
            </span>
            <span className="font-brand-body text-2xs uppercase tracking-wide text-brand-content-muted">
              Dark
            </span>
          </div>
          {ROLE_NAMES.map((role) => (
            <ThemeRow
              key={role}
              role={role}
              canon={canon}
              lightHex={lightRoles[role]}
              darkHex={darkRoles[role]}
            />
          ))}
        </div>
      </section>

      {canon.usageRatios.length > 0 && (
        <section className="mb-8">
          <SubHead
            title="Usage"
            description="Roughly how much of a composition each role should occupy."
          />
          <RatioBar ratios={canon.usageRatios} hexForRole={(role) => lightRoles[role]} />
        </section>
      )}

      {/* Forbidden combinations, as illustrated rules rather than a tiny list.
          "Seal Red on Indigo vibrates" is a claim you have to take on trust
          until you see it, so each rule carries an image slot. */}
      {forbidden.length > 0 && (
        <section>
          <SubHead
            title="Forbidden"
            description="Combinations that must never ship. Each one fails a review on its own."
          />
          <RuleGrid rules={forbidden} assetsById={assetsById} />
        </section>
      )}
    </GuideSection>
  );
}
