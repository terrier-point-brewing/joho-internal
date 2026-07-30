import { assetFileUrl } from "@/lib/brand/assets";

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
  alt,
  caption,
}: {
  assetId?: string;
  alt: string;
  caption?: string;
}) {
  return (
    <figure>
      <div className="aspect-[16/10] rounded border border-brand-line bg-brand-surface flex items-center justify-center overflow-hidden">
        {assetId ? (
          // eslint-disable-next-line @next/next/no-img-element -- session-gated brand asset from the proxy route, not a static import
          <img
            src={assetFileUrl(assetId)}
            alt={alt}
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
