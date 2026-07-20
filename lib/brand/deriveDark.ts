import type { RoleName } from "./canon.types";

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function hexToHsl(hex: string): Hsl {
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

function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100;
  const lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp >= 0 && hp < 1) {
    r1 = c;
    g1 = x;
  } else if (hp >= 1 && hp < 2) {
    r1 = x;
    g1 = c;
  } else if (hp >= 2 && hp < 3) {
    g1 = c;
    b1 = x;
  } else if (hp >= 3 && hp < 4) {
    g1 = x;
    b1 = c;
  } else if (hp >= 4 && hp < 5) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }
  const m = lN - c / 2;
  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
}

type Treatment =
  | { k: "bgDark"; L: number }
  | { k: "contentLight"; L: number }
  | { k: "lift"; L: number }
  | { k: "brighten"; L: number }
  | { k: "keep" };

const TREATMENTS: Record<RoleName, Treatment> = {
  canvas: { k: "bgDark", L: 12 },
  surface: { k: "bgDark", L: 16 },
  "surface-raised": { k: "bgDark", L: 21 },
  line: { k: "bgDark", L: 26 },
  "line-strong": { k: "bgDark", L: 34 },
  "high-contrast": { k: "contentLight", L: 92 },
  content: { k: "contentLight", L: 80 },
  "content-muted": { k: "contentLight", L: 66 },
  primary: { k: "lift", L: 60 },
  accent: { k: "brighten", L: 60 },
  secondary: { k: "keep" },
  "on-primary": { k: "keep" },
  "on-accent": { k: "keep" },
};

const BG_DARK_S = 28;
const CONTENT_LIGHT_S = 25;
const DEFAULT_CONTENT_HUE = 40;

export function deriveDarkPalette(light: Record<RoleName, string>): Record<RoleName, string> {
  const primaryHue = hexToHsl(light.primary).h;
  const contentHue = light["high-contrast"] ? hexToHsl(light["high-contrast"]).h : DEFAULT_CONTENT_HUE;

  const out = {} as Record<RoleName, string>;
  for (const role of Object.keys(TREATMENTS) as RoleName[]) {
    const t = TREATMENTS[role];
    switch (t.k) {
      case "bgDark":
        out[role] = hslToHex(primaryHue, BG_DARK_S, t.L);
        break;
      case "contentLight":
        out[role] = hslToHex(contentHue || DEFAULT_CONTENT_HUE, CONTENT_LIGHT_S, t.L);
        break;
      case "lift":
      case "brighten": {
        const own = hexToHsl(light[role]);
        out[role] = hslToHex(own.h, own.s, t.L);
        break;
      }
      case "keep":
        out[role] = light[role];
        break;
    }
  }
  return out;
}
