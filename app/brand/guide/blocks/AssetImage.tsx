import { assetFileUrl, type BrandAsset } from "@/lib/brand/assets";

/**
 * The one place brand imagery is sized.
 *
 * Every uploaded asset lands in the same aspect-locked box with
 * `object-contain`, so a 4000px screenshot and a 200px SVG render identically
 * and nothing an admin uploads can distort the grid around it. Centralising
 * that is the point — per-view sizing is how upload-driven layouts drift.
 *
 * With no `assetId` it renders a neutral placeholder rather than collapsing:
 * phase 2 ships the structure before the artwork exists, so an empty slot has
 * to hold its space and read as deliberate.
 */
export default function AssetImage({
  assetId,
  asset,
  alt,
  caption,
}: {
  assetId?: string;
  /** The resolved row, when available — carries the authored alt text. */
  asset?: BrandAsset;
  /** Fallback description, derived from whatever the image sits beside. */
  alt: string;
  caption?: string;
}) {
  // The uploader's own description wins: they are the only person who knows
  // what the image depicts. The derived fallback is better than nothing but
  // describes the rule, not the picture.
  const description = asset?.alt_text || alt;
  return (
    <figure>
      {/* Capped in height as well as aspect. These sit two-to-a-row inside a
          do/don't grid, so an unbounded box makes each rule taller than a
          screen and turns a scannable comparison into a scroll. */}
      <div className="aspect-[16/10] max-h-56 rounded border border-brand-line bg-brand-surface flex items-center justify-center overflow-hidden">
        {assetId ? (
          // eslint-disable-next-line @next/next/no-img-element -- session-gated brand asset from the proxy route, not a static import
          <img
            src={assetFileUrl(assetId)}
            alt={description}
            className="max-h-full max-w-full w-auto object-contain"
          />
        ) : (
          <span className="font-brand-body text-2xs uppercase tracking-wide text-brand-content-muted">
            Artwork pending
          </span>
        )}
      </div>
      {caption && (
        <figcaption className="font-brand-body text-2xs text-brand-content-muted mt-1.5">
          {caption}
        </figcaption>
      )}
    </figure>
  );
}
