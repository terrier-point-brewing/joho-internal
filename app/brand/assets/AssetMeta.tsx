"use client";

import { useState } from "react";
import type { BrandAsset } from "@/lib/brand/assets";
import { useUpdateAssetMeta } from "./useAssets";

/**
 * Inline title and alt-text editing for one asset.
 *
 * Editable after upload, not only during it. A library of any size accumulates
 * files whose storage variant means nothing to anyone reading a picker, and
 * re-uploading a file purely to name it is not a reasonable ask.
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

  const dirty = title !== (asset.title ?? "") || altText !== (asset.alt_text ?? "");

  function save() {
    if (!dirty) return;
    update.mutate({ id: asset.id, title, alt_text: altText });
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
      {!asset.alt_text && !altText && (
        <span className="text-2xs text-faint">No alt text — screen readers get nothing.</span>
      )}
    </div>
  );
}
