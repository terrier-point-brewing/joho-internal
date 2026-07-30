import type { BrandAsset } from "@/lib/brand/assets";
import { assetFileUrl } from "@/lib/brand/assets";

/**
 * A mark's artwork, plus a download for every format it ships in.
 *
 * All artwork lands in the same aspect-locked `object-contain` box. An identity
 * mark can arrive as a 4000px PNG or a 60px SVG, and without one component
 * owning the sizing a single upload reflows the whole grid around it.
 *
 * A vector is preferred for display when one exists — SVG stays crisp at the
 * box's size where a raster may not — but every format is offered for download,
 * because the person who needs the PDF is not the person reading the page.
 */

/** Formats that render reliably in an <img>. PDFs and archives are download-only. */
const DISPLAYABLE = new Set(["svg", "png", "jpg", "jpeg", "webp", "gif"]);

function pickDisplayAsset(assets: BrandAsset[]): BrandAsset | null {
  const displayable = assets.filter((a) => DISPLAYABLE.has(a.format.toLowerCase()));
  return displayable.find((a) => a.format.toLowerCase() === "svg") ?? displayable[0] ?? null;
}

export default function MarkArtwork({
  assets,
  alt,
}: {
  assets: BrandAsset[];
  alt: string;
}) {
  const display = pickDisplayAsset(assets);

  return (
    <div>
      <div className="aspect-[16/9] rounded border border-brand-line bg-brand-surface flex items-center justify-center overflow-hidden p-4">
        {display ? (
          // eslint-disable-next-line @next/next/no-img-element -- session-gated brand asset from the proxy route
          <img
            src={assetFileUrl(display.id)}
            alt={alt}
            className="max-h-full max-w-full w-auto object-contain"
          />
        ) : (
          <span className="font-brand-body text-2xs uppercase tracking-wide text-brand-content-muted">
            Artwork pending
          </span>
        )}
      </div>

      {assets.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {assets.map((asset) => (
            <a
              key={asset.id}
              href={assetFileUrl(asset.id)}
              download
              className="font-brand-body text-2xs uppercase tracking-wide rounded border border-brand-line px-1.5 py-0.5 text-brand-content-muted hover:border-brand-line-strong hover:text-brand-content"
            >
              {asset.format}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
