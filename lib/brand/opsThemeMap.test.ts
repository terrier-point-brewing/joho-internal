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

  it("never overrides status colors (danger/success/info keep their meaning)", () => {
    const css = opsChromeOverrideCss(light, dark);
    expect(css).not.toContain("--color-danger");
    expect(css).not.toContain("--color-success");
    expect(css).not.toContain("--color-info");
  });

  it("skips a non-hex (potentially unsafe) value instead of injecting it", () => {
    const poisoned = { ...light, canvas: "#000;} body{display:none}" };
    const css = opsChromeOverrideCss(poisoned, dark);
    expect(css).not.toContain("display:none");
    expect(css).not.toContain("--color-canvas:#000;}");
    expect(css).toContain(`--color-surface:${light.surface};`);
  });
});
