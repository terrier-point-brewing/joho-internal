import { describe, expect, it } from "vitest";
import { OPS_TO_BRAND_ROLE, opsChromeOverrideCss } from "./opsThemeMap";
import { resolveTokens } from "./tokens";
import { seedCanon } from "./seedCanon";

describe("opsChromeOverrideCss", () => {
  const dark = resolveTokens(seedCanon).dark;

  it("emits a :root override for every mapped ops token", () => {
    const css = opsChromeOverrideCss(dark);
    for (const opsToken of Object.keys(OPS_TO_BRAND_ROLE)) {
      expect(css).toContain(`--color-${opsToken}:`);
    }
    expect(css.startsWith(":root{")).toBe(true);
  });

  it("repoints ops canvas/surface/accent at the brand dark palette", () => {
    const css = opsChromeOverrideCss(dark);
    expect(css).toContain(`--color-canvas:${dark.canvas};`);
    expect(css).toContain(`--color-surface:${dark.surface};`);
    // accent maps to brand PRIMARY (indigo), not the brand accent (Seal Red)
    expect(css).toContain(`--color-accent:${dark.primary};`);
  });

  it("never overrides status colors (danger/success/info keep their meaning)", () => {
    const css = opsChromeOverrideCss(dark);
    expect(css).not.toContain("--color-danger");
    expect(css).not.toContain("--color-success");
    expect(css).not.toContain("--color-info");
  });

  it("skips a non-hex (potentially unsafe) value instead of injecting it", () => {
    const poisoned = { ...dark, canvas: "#000;} body{display:none}" };
    const css = opsChromeOverrideCss(poisoned);
    expect(css).not.toContain("display:none");
    expect(css).not.toContain("--color-canvas:#000");
    // other valid tokens still emitted
    expect(css).toContain(`--color-surface:${dark.surface};`);
  });
});
