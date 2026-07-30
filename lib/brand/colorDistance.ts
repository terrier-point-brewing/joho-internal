/**
 * Perceptual color distance, in OKLab.
 *
 * Used to decide whether a derived dark-mode color is close enough to an
 * existing palette color to bind to it, or whether the palette needs a new
 * entry. RGB euclidean distance is not fit for that judgement — it happily
 * reports warm Camphor Tan as "close to" a cool blue-grey, which is precisely
 * the mistake that would silently warm every dark-mode text color.
 */

/** Threshold below which two colors are close enough to treat as the same. */
export const SNAP_THRESHOLD = 0.06;

function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** sRGB hex → OKLab. Returns [L, a, b]. */
export function hexToOklab(hex: string): [number, number, number] {
  const r = toLinear(parseInt(hex.slice(1, 3), 16));
  const g = toLinear(parseInt(hex.slice(3, 5), 16));
  const b = toLinear(parseInt(hex.slice(5, 7), 16));

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Perceptual distance between two hex colors. 0 = identical. */
export function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = hexToOklab(a);
  const [l2, a2, b2] = hexToOklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** The palette entry closest to `hex`, or null for an empty palette. */
export function nearestKey(
  hex: string,
  palette: { key: string; hex: string }[],
): { key: string; distance: number } | null {
  let best: { key: string; distance: number } | null = null;
  for (const color of palette) {
    const distance = deltaE(hex, color.hex);
    if (!best || distance < best.distance) best = { key: color.key, distance };
  }
  return best;
}
