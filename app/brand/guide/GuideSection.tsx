import type { ReactNode } from "react";
import { splitParagraphs } from "@/lib/brand/guideIntros";

/** Shared second-level label style (sub-headings within a section). */
export const KICKER =
  "font-brand-body text-xs font-semibold uppercase tracking-wide text-brand-content-muted";

/**
 * Shell for one Brand Guide subtab: the editable introduction block, then the
 * subtab's content. No heading — the subtab label already names the section —
 * and no rule between the introduction and the content.
 */
export default function GuideSection({
  intro,
  children,
}: {
  intro?: string;
  children: ReactNode;
}) {
  const paragraphs = splitParagraphs(intro ?? "");

  return (
    <section>
      {paragraphs.length > 0 && (
        <div className="mb-8 flex flex-col gap-3 max-w-3xl">
          {paragraphs.map((p, i) => (
            <p key={i} className="font-brand-body text-base text-brand-content leading-relaxed">
              {p}
            </p>
          ))}
        </div>
      )}
      {children}
    </section>
  );
}
