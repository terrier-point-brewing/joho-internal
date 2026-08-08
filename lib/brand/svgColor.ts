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
 * How light the artwork's own ink is, and how far it spreads.
 *
 * Deliberately a measurement rather than a colour or a class name: the same
 * number has to answer the question for an SVG (colours parsed out of the
 * markup) and for a PNG (pixels averaged off a canvas), and a stored class name
 * would have to be re-derived every time the rendering rule changes.
 */
export interface ArtworkLuminance {
  /** Mean WCAG luminance of the artwork's ink, 0–1. */
  mean: number;
  /** Lightest minus darkest — how much contrast the artwork carries itself. */
  spread: number;
}

export function luminanceStats(colors: string[]): ArtworkLuminance | null {
  if (colors.length === 0) return null;
  const lums = colors.map(luminance);
  return {
    mean: lums.reduce((sum, l) => sum + l, 0) / lums.length,
    spread: Math.max(...lums) - Math.min(...lums),
  };
}

/**
 * Which ground a measured piece of artwork should sit on.
 *
 * `neutral` when there was nothing to measure, or when the artwork spans most
 * of the luminance range — a mark that carries its own light-on-dark contrast
 * reads acceptably either way, and guessing would be worse than the default
 * surface. Mid-luminance ink (around 0.5) has no good answer in either
 * direction, so it takes the neutral surface rather than flip-flopping on a
 * rounding difference between the SVG and the PNG of one drawing.
 */
export function groundForLuminance(stats: ArtworkLuminance | null): ArtworkGround {
  if (!stats) return "neutral";
  if (stats.spread > 0.5) return "neutral";
  if (stats.mean > PIVOT - BAND && stats.mean < PIVOT + BAND) return "neutral";
  // Pale artwork gets a dark ground and dark artwork gets a pale one.
  return stats.mean > PIVOT ? "dark" : "light";
}

/**
 * Where a colour stops contrasting better with black than with white — the
 * crossover of the two WCAG contrast ratios, and NOT 0.5. Luminance is a
 * gamma-corrected quantity, so mid-grey (#808080) sits at 0.216, and splitting
 * at the arithmetic midpoint would send most of the visible range to a pale
 * ground including colours that are plainly light.
 */
const PIVOT = 0.1791;

/**
 * Half-width of the dead band around the pivot. Ink this close to the crossover
 * contrasts about equally either way, so there is no answer worth committing
 * to — and committing anyway means an SVG and its PNG can land on opposite
 * grounds over a rounding difference.
 */
const BAND = 0.05;

/** The luminance of an SVG's ink, read from the colours it paints with. */
export function luminanceForSvg(svg: string): ArtworkLuminance | null {
  return luminanceStats(extractSvgColors(svg));
}

/** Which ground an SVG should sit on. */
export function groundForSvg(svg: string): ArtworkGround {
  return groundForLuminance(luminanceForSvg(svg));
}
