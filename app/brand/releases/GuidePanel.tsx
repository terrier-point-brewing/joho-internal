"use client";

// "From the brand guide" — the block at the head of every release component
// card, rendering whatever lib/brand/releaseGuide.ts resolved for it from the
// published canon.
//
// Built from the ops UI kit rather than the guide's own blocks/SpecCard. The
// brand tokens are on :root app-wide so SpecCard would render here, but it
// would put a brand-skinned card on an ops-skinned surface — the guide keeps
// its palette, the workbench keeps its own.
//
// Collapsed by default: this is reference material for someone writing a
// release, not something to read on every visit. A card the guide says nothing
// about (Beer Recipe, Product Codes) renders only the link — see the "why only
// two cards" note in releaseGuide.ts.

import { useState } from "react";
import Link from "next/link";
import { RELEASE_GUIDE_HREF, isEmptyGuideEntry, type ReleaseGuideEntry } from "@/lib/brand/releaseGuide";

export default function GuidePanel({ entry }: { entry: ReleaseGuideEntry | undefined }) {
  const [open, setOpen] = useState(false);
  const empty = isEmptyGuideEntry(entry);

  return (
    <div className="rounded-lg border border-line bg-surface-mid/40 px-3 py-2 mb-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        {empty ? (
          <span className="text-xs text-muted">
            The brand guide doesn&apos;t govern this step — the notes below are ours.
          </span>
        ) : (
          <button
            type="button"
            className="text-xs text-secondary hover:text-primary"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            {open ? "▾" : "▸"} From the brand guide
          </button>
        )}
        <Link href={RELEASE_GUIDE_HREF} className="text-xs text-accent hover:underline shrink-0">
          Read: Release Design →
        </Link>
      </div>

      {!empty && open && entry && (
        <div className="flex flex-col gap-3 mt-3">
          {entry.intro && <p className="text-sm text-secondary leading-relaxed">{entry.intro}</p>}

          {entry.rules.length > 0 && (
            <ol className="flex flex-col gap-1">
              {entry.rules.map((rule, i) => (
                <li key={rule} className="flex gap-2 text-sm text-body">
                  <span className="text-muted tabular-nums shrink-0">{i + 1}.</span>
                  <span>{rule}</span>
                </li>
              ))}
            </ol>
          )}

          {entry.rows.length > 0 && (
            <dl className="flex flex-col gap-2">
              {entry.rows.map((row) => (
                <div key={row.label} className="flex flex-col">
                  <dt className="text-xs text-secondary">{row.label}</dt>
                  <dd className="text-sm text-body">{row.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {entry.footer && <p className="text-xs text-muted italic">{entry.footer}</p>}
        </div>
      )}
    </div>
  );
}
