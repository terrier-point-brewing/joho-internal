import { describe, expect, it } from "vitest";
import { toScopedVars } from "./BrandPreview";
import type { ResolvedTokens } from "@/lib/brand/canon.types";

const tokens: ResolvedTokens = {
  light: {
    canvas: "#f5f0e6",
    surface: "#efe8da",
    "surface-raised": "#ded5c1",
    primary: "#26355d",
    "on-primary": "#f5f0e6",
    secondary: "#b3a585",
    accent: "#ad1a2d",
    "on-accent": "#f5f0e6",
    "high-contrast": "#26355d",
    content: "#3a4256",
    "content-muted": "#6b6f7d",
    line: "#ded5c1",
    "line-strong": "#b3a585",
  },
  dark: {
    canvas: "#1a1710",
    surface: "#221e15",
    "surface-raised": "#2c2619",
    primary: "#5a75b8",
    "on-primary": "#1a1710",
    secondary: "#b3a585",
    accent: "#e0536b",
    "on-accent": "#1a1710",
    "high-contrast": "#dbe0ee",
    content: "#c7ccdb",
    "content-muted": "#a3a8b8",
    line: "#3a331f",
    "line-strong": "#4d4327",
  },
  fonts: {
    display: '"Marcellus", serif',
    body: '"Lato", sans-serif',
    wordmark: '"Jost", sans-serif',
    script: '"Noto Serif SC", serif',
  },
};

describe("toScopedVars", () => {
  it("maps --color-brand-canvas to the light hex in light mode", () => {
    const vars = toScopedVars(tokens, "light");
    expect(vars["--color-brand-canvas"]).toBe("#f5f0e6");
  });

  it("maps --color-brand-canvas to the dark hex in dark mode", () => {
    const vars = toScopedVars(tokens, "dark");
    expect(vars["--color-brand-canvas"]).toBe("#1a1710");
  });

  it("returns all 13 role vars", () => {
    const vars = toScopedVars(tokens, "light");
    const expectedKeys = [
      "--color-brand-canvas",
      "--color-brand-surface",
      "--color-brand-surface-raised",
      "--color-brand-primary",
      "--color-brand-on-primary",
      "--color-brand-secondary",
      "--color-brand-accent",
      "--color-brand-on-accent",
      "--color-brand-high-contrast",
      "--color-brand-content",
      "--color-brand-content-muted",
      "--color-brand-line",
      "--color-brand-line-strong",
    ];
    expect(Object.keys(vars).sort()).toEqual(expectedKeys.sort());
  });
});
