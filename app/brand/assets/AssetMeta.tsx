"use client";

import { useState } from "react";
import type { BrandAsset } from "@/lib/brand/assets";
import { useUpdateAssetMeta } from "./useAssets";

/**
 * Inline slug, title and alt-text editing for one asset.
 *
 * Editable after upload, not only during it. A library of any size accumulates
 * files whose storage variant means nothing to anyone reading a picker, and
 * re-uploading a file purely to name it is not a reasonable ask.
 *
 * The slug is the third field rather than the first because it is the one with
 * consequences: it is the grouping key `resolveAsset` looks a mark up by, so
 * retyping it re-files the asset onto a different card. Title is the free-text
 * label and is what a person normally means by renaming; slug is offered next
 * to it for the case where the upload landed under the wrong variation.
 *
 * Alt text is prompted for rather than assumed. Marks and do/don't imagery are
 * shown as images with no adjacent prose describing them, so the only
 * description a screen reader gets is whatever is written here — and only the
 * person who uploaded the file knows what it depicts.
 */
export default function AssetMeta({ asset }: { asset: BrandAsset }) {
  const update = useUpdateAssetMeta();
  const [title, setTitle] = useState(asset.title ?? "");
  const [altText, setAltText] = useState(asset.alt_text ?? "");
  const [variant, setVariant] = useState(asset.variant);

  const dirty =
    title !== (asset.title ?? "") || altText !== (asset.alt_text ?? "") || variant !== asset.variant;

  function save() {
    if (!dirty) return;
    // Slug only when it actually changed: sending it every time would push a
    // normalized slug back over one the server left alone, and would re-run the
    // one-approved clash check on an edit that is really just a retitle.
    update.mutate(
      {
        id: asset.id,
        title,
        alt_text: altText,
        ...(variant !== asset.variant ? { variant } : {}),
      },
      {
        // A rejected slug (another approved file of this format already owns it)
        // leaves the row untouched, so the input has to go back to the truth
        // rather than keep showing a name that was never saved.
        onError: () => setVariant(asset.variant),
      },
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <input
        className="inp-sm"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={save}
        placeholder={asset.variant}
        aria-label="Asset title"
      />
      <input
        className="inp-sm"
        value={altText}
        onChange={(e) => setAltText(e.target.value)}
        onBlur={save}
        placeholder="Describe the image…"
        aria-label="Alternative text"
      />
      <input
        className="inp-sm font-mono text-2xs"
        value={variant}
        onChange={(e) => setVariant(e.target.value)}
        onBlur={save}
        placeholder="default"
        aria-label="Variation slug"
      />
      {update.error && (
        <span className="text-2xs text-danger">{(update.error as Error).message}</span>
      )}
      {!asset.alt_text && !altText && (
        <span className="text-2xs text-faint">No alt text — screen readers get nothing.</span>
      )}
    </div>
  );
}
