import { describe, expect, it } from "vitest";
import { deriveDarkPalette } from "./deriveDark";
import { seedCanon } from "./seedCanon";
import type { RoleName } from "./canon.types";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

// resolve light hexes inline from the seed canon (mirrors resolveTokens' logic)
function resolveLight(): Record<RoleName, string> {
  const paletteByKey = new Map(seedCanon.palette.map((c) => [c.key, c.hex]));
  const out = {} as Record<RoleName, string>;
  for (const [role, value] of Object.entries(seedCanon.roleMap.light)) {
    out[role as RoleName] = paletteByKey.get(value) ?? value;
  }
  return out;
}

describe("deriveDarkPalette", () => {
  const light = resolveLight();
  const dark = deriveDarkPalette(light);
  const primaryHue = hexToHsl(light.primary).h;

  it("canvas dark is dark and hued toward primary", () => {
    const { h, l } = hexToHsl(dark.canvas);
    expect(l).toBeLessThan(20);
    const diff = Math.min(Math.abs(h - primaryHue), 360 - Math.abs(h - primaryHue));
    expect(diff).toBeLessThanOrEqual(12);
  });

  it("high-contrast dark is very light", () => {
    const { l } = hexToHsl(dark["high-contrast"]);
    expect(l).toBeGreaterThan(85);
  });

  it("primary dark is legible on dark (50-70% lightness)", () => {
    const { l } = hexToHsl(dark.primary);
    expect(l).toBeGreaterThanOrEqual(50);
    expect(l).toBeLessThanOrEqual(70);
  });

  it("on-primary dark equals its light value (keep)", () => {
    expect(dark["on-primary"]).toBe(light["on-primary"]);
  });

  it("has all 13 RoleName keys, each a valid hex", () => {
    const roles: RoleName[] = [
      "canvas",
      "surface",
      "surface-raised",
      "primary",
      "on-primary",
      "secondary",
      "accent",
      "on-accent",
      "high-contrast",
      "content",
      "content-muted",
      "line",
      "line-strong",
    ];
    expect(Object.keys(dark).length).toBe(13);
    for (const role of roles) {
      expect(dark[role]).toMatch(HEX_RE);
    }
  });
});
