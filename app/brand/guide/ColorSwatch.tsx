"use client";

import { useState } from "react";

/**
 * Click-to-copy color swatch. The guide viewer is a server component, so this
 * tiny client leaf owns the onClick + clipboard interaction; everything else
 * (layout, data) stays server-rendered. Brand-namespaced tokens only.
 */
export default function ColorSwatch({
  label,
  swatchName,
  hex,
  swatchClassName,
  pct,
}: {
  label: string;
  swatchName: string;
  hex: string;
  swatchClassName: string;
  pct?: number;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(hex);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard unavailable (e.g. insecure context) — no-op
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="flex flex-col gap-1.5 text-left"
      title={`Copy ${hex}`}
    >
      <div className={`h-16 rounded-lg border border-brand-line ${swatchClassName}`} />
      <span className="text-xs font-brand-body text-brand-content">
        {label}
        <span className="text-brand-content-muted"> · {swatchName}</span>
        {pct != null && <span className="text-brand-content-muted"> · {pct}%</span>}
      </span>
      <span className="text-2xs font-brand-body text-brand-content-muted">
        {copied ? "Copied!" : hex}
      </span>
    </button>
  );
}
