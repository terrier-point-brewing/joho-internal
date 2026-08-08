"use client";

import { useCallback, useState } from "react";
import type { BrandAsset } from "@/lib/brand/assets";
import { assetFileUrl } from "@/lib/brand/assets";
import { pickDisplayAsset } from "@/lib/brand/marks";
import { luminanceForImage } from "@/lib/brand/rasterLuminance";
import { groundForLuminance, type ArtworkGround } from "@/lib/brand/svgColor";

/**
 * A mark's artwork, with a switch between the formats it ships in.
 *
 * All artwork lands in the same aspect-locked `object-contain` box. An identity
 * mark can arrive as a 4000px PNG or a 60px SVG, and without one component
 * owning the sizing a single upload reflows the whole grid around it.
 *
 * The vector opens by default — it stays crisp at whatever size the box
 * resolves to — but the switch is the point: a variation shipped as both an SVG
 * and a PNG is one variation, and someone choosing which file to take needs to
 * see that they are the same drawing before they take one. Formats an <img>
 * can't render (a PDF, an archive) never appear in the switch; they are offered
 * as downloads only, because the person who needs the PDF is not the person
 * reading the page.
 */

/** Formats that render reliably in an <img>. PDFs and archives are download-only. */
const DISPLAYABLE = new Set(["svg", "png", "jpg", "jpeg", "webp", "gif"]);

/**
 * Ground colours for the artwork box.
 *
 * Identity marks are usually one flat colour on a transparent background, so a
 * pale wordmark on the default pale surface renders as an empty box — the
 * upload looks broken when it is fine. `grounds` comes from measuring the
 * artwork itself (lib/brand/svgColor.ts), applied per variation so the SVG and
 * the PNG of one drawing can't disagree across the format switch.
 *
 * `light`/`dark` are fixed colours rather than brand tokens: the ink in an
 * uploaded file doesn't flip with the app's theme, so the ground chosen to
 * contrast with it mustn't either. See the artwork-ground block in globals.css.
 * `neutral` is the artwork that carries its own contrast, and that one does
 * follow the theme — there's nothing to protect.
 */
const GROUND_CLASS: Record<ArtworkGround, string> = {
  light: "artwork-ground-light",
  dark: "artwork-ground-dark",
  neutral: "bg-brand-surface",
};

export default function MarkArtwork({
  assets,
  alt,
  grounds = {},
  aspect = "aspect-[16/9]",
}: {
  assets: BrandAsset[];
  alt: string;
  /** Per-asset background choice. A plain object, not a Map — it crosses the
   *  server/client boundary. */
  grounds?: Record<string, ArtworkGround>;
  /** Tailwind aspect class for the box. Chops are square; wordmarks are not. */
  aspect?: string;
}) {
  const viewable = assets.filter((a) => DISPLAYABLE.has(a.format.toLowerCase()));
  const [selectedId, setSelectedId] = useState<string | null>(
    () => pickDisplayAsset(assets)?.id ?? null,
  );
  const display = viewable.find((a) => a.id === selectedId) ?? viewable[0] ?? null;

  // A variation that ships only as a raster has no server-side measurement —
  // reading a PNG's ink there would mean decoding the image on the server, for
  // a background choice. Measured off the rendered <img> instead, which costs a
  // canvas draw on a file the browser has already decoded to show it. One
  // measurement for the whole card: `assets` is one variation, one drawing.
  const [measured, setMeasured] = useState<ArtworkGround | null>(null);
  const known = display ? grounds[display.id] : undefined;
  const ground = known ?? measured ?? "neutral";

  const measure = useCallback(
    (event: React.SyntheticEvent<HTMLImageElement>) => {
      if (known || measured) return;
      const stats = luminanceForImage(event.currentTarget);
      if (stats) setMeasured(groundForLuminance(stats));
    },
    [known, measured],
  );

  return (
    <div>
      <div
        className={`${aspect} rounded border border-brand-line flex items-center justify-center overflow-hidden p-4 ${GROUND_CLASS[ground]}`}
      >
        {display ? (
          // eslint-disable-next-line @next/next/no-img-element -- session-gated brand asset from the proxy route
          <img
            src={assetFileUrl(display.id)}
            alt={display.alt_text || alt}
            onLoad={measure}
            className="max-h-full max-w-full w-auto object-contain"
          />
        ) : (
          <span className="font-brand-body text-2xs uppercase tracking-wide text-brand-content-muted">
            Artwork pending
          </span>
        )}
      </div>

      {/* The switch, only when there is something to switch between. One
          format needs no chooser, and rendering a single dead toggle reads as
          a control that has stopped working. */}
      {viewable.length > 1 && (
        <div
          className="flex flex-wrap gap-1 mt-2"
          role="group"
          aria-label={`${alt} — file format`}
        >
          {viewable.map((asset) => {
            const active = asset.id === display?.id;
            return (
              <button
                key={asset.id}
                type="button"
                aria-pressed={active}
                onClick={() => setSelectedId(asset.id)}
                className={`font-brand-body text-2xs uppercase tracking-wide rounded border px-1.5 py-0.5 ${
                  active
                    ? "border-brand-line-strong bg-brand-surface text-brand-high-contrast"
                    : "border-brand-line text-brand-content-muted hover:border-brand-line-strong hover:text-brand-content"
                }`}
              >
                {asset.format}
              </button>
            );
          })}
        </div>
      )}

      {assets.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 mt-1.5">
          <span className="font-brand-body text-2xs uppercase tracking-wide text-brand-content-muted">
            Download
          </span>
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
