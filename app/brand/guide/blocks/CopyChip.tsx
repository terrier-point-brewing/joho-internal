"use client";

import { useState } from "react";

/**
 * A click-to-copy code chip.
 *
 * Every print and screen code gets its own chip so each can be copied on its
 * own. The guide previously exposed only the hex — a designer setting up a
 * print job had the CMYK and Pantone values stored in the canon and no way to
 * get at them short of opening the database.
 */
export default function CopyChip({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard unavailable (insecure context) — the value stays visible and
      // selectable, so this degrades to "copy it by hand" rather than breaking.
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={`Copy ${label} — ${value}`}
      className="font-brand-body text-2xs rounded border border-brand-line px-1.5 py-0.5 text-brand-content-muted hover:border-brand-line-strong hover:text-brand-content"
    >
      <span className="uppercase tracking-wide">{label}</span>{" "}
      <span className="text-brand-content">{copied ? "copied" : value}</span>
    </button>
  );
}
