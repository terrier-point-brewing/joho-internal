import { describe, expect, it } from "vitest";
import { resolveTokens, emitBrandCss } from "./tokens";
import { seedCanon } from "./seedCanon";
import type { BrandCanon } from "./canon.types";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

describe("resolveTokens", () => {
  it("resolves a palette key to its hex", () => {
    const t = resolveTokens(seedCanon);
    expect(t.light.primary).toBe("#26355d");
  });

  it("dark.primary differs from light and is a valid hex", () => {
    const t = resolveTokens(seedCanon);
    expect(t.dark.primary).not.toBe(t.light.primary);
    expect(t.dark.primary).toMatch(HEX_RE);
  });

  it("dark on-primary equals light on-primary", () => {
    const t = resolveTokens(seedCanon);
    expect(t.dark["on-primary"]).toBe(t.light["on-primary"]);
  });

  it("a roleMap.dark override wins over derivation", () => {
    const variant: BrandCanon = {
      ...seedCanon,
      roleMap: { ...seedCanon.roleMap, dark: { primary: "#123456" } },
    };
    const t = resolveTokens(variant);
    expect(t.dark.primary).toBe("#123456");
  });

  it("resolves fonts.display to the Marcellus stack", () => {
    const t = resolveTokens(seedCanon);
    expect(t.fonts.display).toBe('"Marcellus", serif');
  });
});

describe("emitBrandCss", () => {
  it("contains the light canvas value, a dark data-theme block, and a media query", () => {
    const css = emitBrandCss(resolveTokens(seedCanon));
    expect(css).toContain("--color-brand-canvas:#f5f0e6");
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain("@media (prefers-color-scheme:dark)");
  });
});
