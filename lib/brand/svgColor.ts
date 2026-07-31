/**
 * Picks a background that keeps an uploaded mark legible.
 *
 * Identity artwork is usually a single flat colour with a transparent
 * background, so a white wordmark on a light surface renders as an empty box —
 * the upload looks broken when it is fine. Reading the artwork's own colour and
 * choosing a ground that contrasts with it fixes that without asking whoever
 * uploaded it to know or care.
 */

const NAMED: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  gray: "#808080",
  grey: "#808080",
};

/** Expands #abc to #aabbcc. */
function expand(hex: string): string {
  if (hex.length === 4) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }
  return hex.slice(0, 7);
}

/**
 * Every colour an SVG paints with, in document order.
 *
 * Deliberately a regex rather than an XML parse: this runs on a trusted
 * uploaded file only to choose a background, so a rough answer is worth far
 * more than a parser dependency. `none` and `transparent` are skipped — they
 * are the absence of paint, which is exactly what makes the artwork invisible.
 */
export function extractSvgColors(svg: string): string[] {
  const out: string[] = [];

  // fill="..." / stroke="..." / stop-color="..." and their CSS equivalents.
  const attr = /(?:fill|stroke|stop-color)\s*[=:]\s*["']?\s*(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)/g;
  for (const match of svg.matchAll(attr)) {
    const raw = match[1].toLowerCase();
    if (raw === "none" || raw === "transparent" || raw === "currentcolor") continue;

    if (raw.startsWith("#")) {
      if (raw.length === 4 || raw.length >= 7) out.push(expand(raw));
      continue;
    }
    if (NAMED[raw]) out.push(NAMED[raw]);
  }

  return out;
}

/** WCAG relative luminance, 0 (black) – 1 (white). */
export function luminance(hex: string): number {
  const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const r = channel(parseInt(hex.slice(1, 3), 16));
  const g = channel(parseInt(hex.slice(3, 5), 16));
  const b = channel(parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export type ArtworkGround = "light" | "dark" | "neutral";

/**
 * Which ground an SVG should sit on.
 *
 * `neutral` when the artwork has no colours to read, or spans both ends of the
 * range (a multi-colour mark reads acceptably either way, and guessing would be
 * worse than the default surface).
 */
export function groundForSvg(svg: string): ArtworkGround {
  const colors = extractSvgColors(svg);
  if (colors.length === 0) return "neutral";

  const lums = colors.map(luminance);
  const lightest = Math.max(...lums);
  const darkest = Math.min(...lums);

  // Spans most of the range — light-on-dark artwork that carries its own
  // contrast. Leave it alone.
  if (lightest - darkest > 0.5) return "neutral";

  const average = lums.reduce((sum, l) => sum + l, 0) / lums.length;
  // 0.5 is the midpoint of the luminance range, so pale artwork gets a dark
  // ground and dark artwork gets a pale one.
  return average > 0.5 ? "dark" : "light";
}
