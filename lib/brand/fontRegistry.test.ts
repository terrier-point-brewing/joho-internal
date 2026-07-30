import { describe, expect, it } from "vitest";
import { BUNDLED_FONTS, fontStackFor, safeFamilyName, sourceOf } from "./fontRegistry";
import { emitBrandCss, resolveTokens } from "./tokens";
import { seedCanon } from "./seedCanon";
import type { BrandCanon } from "./canon.types";

const font = (over: Partial<BrandCanon["fonts"][number]> = {}) => ({
  role: "display" as const,
  family: "Marcellus",
  cssStack: '"Marcellus", serif',
  weights: [400],
  ...over,
});

describe("fontStackFor", () => {
  it("chains a bundled family through its next/font variable", () => {
    // The whole point: emitting the stored cssStack would override the
    // next/font chain and silently fall back to a generic serif.
    expect(fontStackFor(font())).toBe('var(--font-marcellus), "Marcellus", serif');
  });

  it("chains every bundled family", () => {
    for (const bundled of BUNDLED_FONTS) {
      const stack = fontStackFor(font({ family: bundled.family, cssStack: "ignored" }));
      expect(stack).toContain(`var(${bundled.cssVar})`);
      expect(stack).not.toBe("ignored");
    }
  });

  it("emits a system stack as authored", () => {
    const stack = fontStackFor(
      font({ family: "Helvetica Neue", cssStack: '"Helvetica Neue", Arial, sans-serif', source: "system" }),
    );
    expect(stack).toBe('"Helvetica Neue", Arial, sans-serif');
  });

  it("emits an uploaded face by family name, since @font-face declares it", () => {
    const stack = fontStackFor(
      font({ family: "Founders Grotesk", cssStack: '"Founders Grotesk", sans-serif', source: "uploaded" }),
    );
    expect(stack).toBe('"Founders Grotesk", sans-serif');
  });
});

describe("sourceOf", () => {
  it("honours an explicit source", () => {
    expect(sourceOf(font({ source: "uploaded" }))).toBe("uploaded");
  });

  it("infers bundled from a known family when unset", () => {
    expect(sourceOf(font())).toBe("bundled");
  });

  it("infers system for an unknown family when unset", () => {
    expect(sourceOf(font({ family: "Helvetica Neue" }))).toBe("system");
  });
});

describe("emitBrandCss font tokens", () => {
  it("emits a --font-brand-* declaration per role", () => {
    const css = emitBrandCss(resolveTokens(seedCanon));

    for (const role of ["display", "body", "wordmark", "script"]) {
      expect(css).toContain(`--font-brand-${role}:`);
    }
  });

  it("emits the var() chain, never a bare family stack", () => {
    // Regression guard for the bug that made the Type editor inert: a bare
    // stack here overrides the next/font chain and degrades silently, passing
    // every build.
    const css = emitBrandCss(resolveTokens(seedCanon));

    expect(css).toContain("--font-brand-display:var(--font-marcellus)");
    expect(css).not.toContain('--font-brand-display:"Marcellus"');
  });

  it("follows a role reassignment made in the canon", () => {
    // The behaviour the editor promised and did not deliver.
    const canon: BrandCanon = {
      ...seedCanon,
      fonts: seedCanon.fonts.map((f) =>
        f.role === "display"
          ? { ...f, family: "Lato", cssStack: '"Lato", sans-serif' }
          : f,
      ),
    };

    expect(emitBrandCss(resolveTokens(canon))).toContain("--font-brand-display:var(--font-lato)");
  });

  it("still emits the color tokens alongside", () => {
    const css = emitBrandCss(resolveTokens(seedCanon));
    expect(css).toContain("--color-brand-canvas:");
    expect(css).toContain('[data-theme="dark"]');
  });
});

describe("safeFamilyName", () => {
  it("passes a normal typeface name through", () => {
    expect(safeFamilyName("Founders Grotesk")).toBe("Founders Grotesk");
    expect(safeFamilyName("Noto Serif SC")).toBe("Noto Serif SC");
    expect(safeFamilyName("SF-Pro_Display")).toBe("SF-Pro_Display");
  });

  it("strips a quote that would terminate the CSS string early", () => {
    // Without this, one stray quote breaks every @font-face rule after it —
    // and a crafted one is CSS injection.
    expect(safeFamilyName('Evil"; } body { display:none } @font-face { font-family:"x')).not.toContain('"');
    expect(safeFamilyName('Evil"; }')).toBe("Evil");
  });

  it("strips braces, semicolons and backslashes", () => {
    expect(safeFamilyName("A{B}C;D\\E")).toBe("ABCDE");
  });

  it("returns null when nothing usable remains", () => {
    expect(safeFamilyName('";{}')).toBeNull();
    expect(safeFamilyName("   ")).toBeNull();
  });
});
