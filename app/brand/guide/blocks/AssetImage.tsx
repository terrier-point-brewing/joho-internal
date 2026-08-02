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

// The two shapes brand imagery is allowed to take, as literal class names —
// Tailwind can't see a class assembled at runtime, so an interpolated
// `aspect-[${ratio}]` would emit no CSS at all and the box would collapse.
//
// Each shape carries its OWN size cap, and 4:3 caps width rather than height on
// purpose: a max-height beats the aspect ratio at wide viewports, so the 16/10
// box silently stretches to 3:1 on a full-width card. Capping the width means
// the ratio is the one thing that never gives — which is what a fixed slot is
// for when two of them have to be compared side by side.
const ASPECTS = {
  "16/10": "aspect-[16/10] max-h-56",
  "4/3": "aspect-[4/3] w-full max-w-md",
} as const;

export default function AssetImage({
  assetId,
  asset,
  alt,
  caption,
  aspect = "16/10",
  pendingNote,
}: {
  assetId?: string;
  /** The resolved row, when available — carries the authored alt text. */
  asset?: BrandAsset;
  /** Fallback description, derived from whatever the image sits beside. */
  alt: string;
  caption?: string;
  /**
   * 4:3 for the paired do/don't panels, where two boxes sit in one row and a
   * squarer frame keeps the pair's images the same height as each other without
   * pushing the nuance line off the screen.
   */
  aspect?: keyof typeof ASPECTS;
  /** What the artwork should show, while it doesn't exist yet. */
  pendingNote?: string;
}) {
  // The uploader's own description wins: they are the only person who knows
  // what the image depicts. The derived fallback is better than nothing but
  // describes the rule, not the picture.
  const description = asset?.alt_text || alt;
  return (
    <figure>
      {/* Bounded as well as aspect-locked. These sit two-to-a-row in a do/don't
          comparison, so an unbounded box makes each rule taller than a screen
          and turns something scannable into a scroll. */}
      <div
        className={`${ASPECTS[aspect]} rounded border border-brand-line bg-brand-surface flex items-center justify-center overflow-hidden`}
      >
        {assetId ? (
          // eslint-disable-next-line @next/next/no-img-element -- session-gated brand asset from the proxy route, not a static import
          <img
            src={assetFileUrl(assetId)}
            alt={description}
            className="max-h-full max-w-full w-auto object-contain"
          />
        ) : (
          // The empty slot names what belongs in it. "Artwork pending" alone
          // says a box is waiting; the brief says what to commission, which is
          // the only useful thing a guide can show before the art exists.
          <div className="flex flex-col items-center gap-1 px-3 text-center">
            <span className="font-brand-body text-2xs uppercase tracking-wide text-brand-content-muted">
              Artwork pending
            </span>
            {pendingNote && (
              <span className="font-brand-body text-2xs text-brand-content-muted leading-snug">
                {pendingNote}
              </span>
            )}
          </div>
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
