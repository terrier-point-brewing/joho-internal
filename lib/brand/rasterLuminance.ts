import { luminance, type ArtworkLuminance } from "./svgColor";

/**
 * The luminance of a raster mark's ink, sampled off a canvas.
 *
 * The SVG side of this reads colours out of the markup (lib/brand/svgColor.ts).
 * A PNG has no markup to read, so the only way to answer the same question is
 * to look at the pixels — which is cheap here and nowhere else: the browser has
 * already downloaded and decoded the file in order to display it, so this is a
 * draw and a read, not a fetch.
 *
 * Two things it has to get right:
 *
 *   Transparent pixels are not ink. A mark is mostly empty space, and averaging
 *   the empty space in drags every answer to the same middling number.
 *
 *   Edges are partly ink. Anti-aliased edge pixels are the mark's colour
 *   blended toward nothing, so counting them whole pulls a pale mark darker
 *   than it is. Weighting each pixel by its own alpha is what makes a thin
 *   wordmark measure the same as a thick one.
 */
export function luminanceForImageData(data: Uint8ClampedArray): ArtworkLuminance | null {
  let weight = 0;
  let weighted = 0;
  let lightest = -1;
  let darkest = 2;

  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    // Below this a pixel is background haze, not the drawing.
    if (alpha < 0.05) continue;
    const lum = luminance(
      `#${[data[i], data[i + 1], data[i + 2]].map((c) => c.toString(16).padStart(2, "0")).join("")}`,
    );
    weight += alpha;
    weighted += lum * alpha;
    // Range comes from the pixels that are essentially solid ink — a blended
    // edge is not a colour the artwork actually uses, and letting the fringe
    // set the range makes every mark look like it carries its own contrast.
    if (alpha > 0.9) {
      if (lum > lightest) lightest = lum;
      if (lum < darkest) darkest = lum;
    }
  }

  if (weight === 0) return null;
  const mean = weighted / weight;
  return { mean, spread: lightest < 0 ? 0 : lightest - darkest };
}

/** Sample size. Big enough for a stable average, small enough to be instant. */
const SAMPLE = 64;

/**
 * Measures a loaded <img>. Returns null when it can't — a zero-size image, a
 * canvas the browser won't hand back (a tainted one), or an image with no ink.
 */
export function luminanceForImage(img: HTMLImageElement): ArtworkLuminance | null {
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (!width || !height) return null;

  const scale = Math.min(1, SAMPLE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  try {
    ctx.drawImage(img, 0, 0, w, h);
    return luminanceForImageData(ctx.getImageData(0, 0, w, h).data);
  } catch {
    // Cross-origin artwork taints the canvas. Assets come through the app's own
    // proxy route so this shouldn't fire, but a background choice is never
    // worth throwing inside a render for.
    return null;
  }
}
