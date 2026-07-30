"use client";

import { useState } from "react";

/**
 * A block of Markdown shown as-is, with a copy button.
 *
 * Deliberately NOT rendered to HTML. The audience is an agent, and the thing
 * being copied is the source — showing formatted output would hide the exact
 * text that gets pasted into a prompt. Markdown-first is the format, not an
 * intermediate step.
 */
export default function MarkdownBlock({
  markdown,
  label,
  filename,
}: {
  markdown: string;
  label: string;
  /** When set, a download button is offered alongside copy. */
  filename?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard unavailable (insecure context) — the text stays on screen and
      // selectable, so this degrades to copying by hand.
    }
  }

  function handleDownload() {
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename ?? "brand-guide.md";
    a.click();
    // Revoke on the next tick — revoking synchronously can cancel the download
    // before the browser has read the blob.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <div className="rounded-lg border border-brand-line overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-brand-line">
        <span className="font-brand-body text-2xs uppercase tracking-wide text-brand-content-muted">
          {label}
        </span>
        <span className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={handleCopy}
            className="font-brand-body text-2xs uppercase tracking-wide rounded border border-brand-line px-2 py-0.5 text-brand-content-muted hover:border-brand-line-strong hover:text-brand-content"
          >
            {copied ? "Copied" : "Copy"}
          </button>
          {filename && (
            <button
              type="button"
              onClick={handleDownload}
              className="font-brand-body text-2xs uppercase tracking-wide rounded border border-brand-line px-2 py-0.5 text-brand-content-muted hover:border-brand-line-strong hover:text-brand-content"
            >
              Download
            </button>
          )}
        </span>
      </div>
      <pre className="px-3 py-2 overflow-x-auto font-mono text-2xs leading-relaxed text-brand-content whitespace-pre-wrap">
        {markdown}
      </pre>
    </div>
  );
}
