import { describe, expect, it } from "vitest";
import { OPS_TO_BRAND_ROLE, opsChromeOverrideCss } from "./opsThemeMap";
import { resolveTokens } from "./tokens";
import { seedCanon } from "./seedCanon";

describe("opsChromeOverrideCss", () => {
  const { light, dark } = resolveTokens(seedCanon);

  it("emits an override for every mapped ops token", () => {
    const css = opsChromeOverrideCss(light, dark);
    for (const opsToken of Object.keys(OPS_TO_BRAND_ROLE)) {
      expect(css).toContain(`--color-${opsToken}:`);
    }
  });

  it("emits light (:root), dark ([data-theme=dark]), and a prefers-color-scheme block with color-scheme", () => {
    const css = opsChromeOverrideCss(light, dark);
    expect(css).toContain(":root{");
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain("@media (prefers-color-scheme:dark)");
    expect(css).toContain("color-scheme:light");
    expect(css).toContain("color-scheme:dark");
  });

  it("uses the light palette for :root and the dark palette for dark mode", () => {
    const css = opsChromeOverrideCss(light, dark);
    // canvas: light value in the light block, dark value in the dark block
    expect(css).toContain(`--color-canvas:${light.canvas};`);
    expect(css).toContain(`--color-canvas:${dark.canvas};`);
    // accent maps to brand PRIMARY (indigo), not the brand accent (Seal Red)
    expect(css).toContain(`--color-accent:${light.primary};`);
  });

  it("flips status colors light/dark without drawing them from the brand palette", () => {
    const css = opsChromeOverrideCss(light, dark);
    // Emitted in both schemes...
    expect(css).toContain("--color-danger:");
    expect(css).toContain("--color-success:");
    expect(css).toContain("--color-info:");
    // ...light with dark-on-tint text (red-700), dark re-asserting globals (red-400).
    expect(css).toContain("--color-danger:#b91c1c;");
    expect(css).toContain("--color-danger:#f87171;");
    expect(css).toContain("--color-success-surface:#f0fdf4;"); // light green-50 tint
    expect(css).toContain("--color-success-surface:#052e16;"); // dark green-950
    // Status hue is independent of the brand palette (not primary/accent hexes).
    expect(css).not.toContain(`--color-danger:${light.primary};`);
    expect(css).not.toContain(`--color-danger:${light.accent};`);
  });

  it("flips the category (--cat-*) palette light/dark with baked hexes", () => {
    const css = opsChromeOverrideCss(light, dark);
    // light: -100 fill, -800 text; dark: -900 mix fill, -300 text — literal
    // hexes (Tailwind v4 does not keep unused palette vars on :root).
    expect(css).toContain("--cat-purple-bg:#f3e8ff;");
    expect(css).toContain("--cat-purple-fg:#6b21a8;");
    expect(css).toContain("--cat-purple-bg:color-mix(in srgb, #581c87 50%, transparent);");
    expect(css).toContain("--cat-purple-fg:#d8b4fe;");
    // no dependence on Tailwind palette vars
    expect(css).not.toContain("var(--color-purple-");
  });

  it("skips a non-hex (potentially unsafe) value instead of injecting it", () => {
    const poisoned = { ...light, canvas: "#000;} body{display:none}" };
    const css = opsChromeOverrideCss(poisoned, dark);
    expect(css).not.toContain("display:none");
    expect(css).not.toContain("--color-canvas:#000;}");
    expect(css).toContain(`--color-surface:${light.surface};`);
  });
});
