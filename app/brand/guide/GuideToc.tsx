"use client";

import { useEffect, useState } from "react";

export interface TocEntry {
  id: string;
  title: string;
}

/**
 * Sticky "Contents" rail for the brand guide (xl screens only). Plain anchor
 * links work with no JS; an IntersectionObserver adds a scroll-spy highlight
 * for the section currently in view. Kept out of the print/mobile flow so the
 * guide reads top-to-bottom on narrow screens.
 */
export default function GuideToc({ entries }: { entries: TocEntry[] }) {
  const [active, setActive] = useState(entries[0]?.id ?? "");

  useEffect(() => {
    const els = entries
      .map((e) => document.getElementById(e.id))
      .filter((el): el is HTMLElement => el != null);
    if (els.length === 0) return;

    const observer = new IntersectionObserver(
      (obsEntries) => {
        const inView = obsEntries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (inView[0]) setActive(inView[0].target.id);
      },
      // Trip the highlight when a heading crosses the upper third of the viewport.
      { rootMargin: "-15% 0px -70% 0px" },
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [entries]);

  return (
    <nav aria-label="Contents" className="hidden xl:block sticky top-4 self-start">
      <p className="font-brand-body text-2xs font-semibold uppercase tracking-wide text-brand-content-muted mb-3">
        Contents
      </p>
      <ul className="flex flex-col">
        {entries.map((entry, i) => {
          const isActive = active === entry.id;
          return (
            <li key={entry.id}>
              <a
                href={`#${entry.id}`}
                aria-current={isActive ? "true" : undefined}
                className={`flex items-baseline gap-2 border-l py-1.5 pl-3 font-brand-body text-sm transition-colors ${
                  isActive
                    ? "border-brand-accent text-brand-high-contrast"
                    : "border-brand-line text-brand-content-muted hover:text-brand-content"
                }`}
              >
                <span className="text-2xs tabular-nums text-brand-accent">
                  {String(i + 1).padStart(2, "0")}
                </span>
                {entry.title}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
