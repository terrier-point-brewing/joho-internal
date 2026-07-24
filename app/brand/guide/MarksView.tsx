import GuideSection from "./GuideSection";

export interface MarkArtifact {
  kind: string;
  label: string;
  url: string | null;
}

/**
 * Marks view: the identity artifacts (wordmark / logo / chop) resolved from the
 * approved Assets library, shown on brand surfaces. Full per-mark specification
 * sheets (à la the wordmark two-cut-J spec) come from canon in a follow-up.
 */
export default function MarksView({ marks }: { marks: MarkArtifact[] }) {
  const present = marks.filter((m) => m.url);

  return (
    <GuideSection
      title="Marks"
      lead="Wordmark, logo, and chop — the fixed identity artifacts. Upload and approve them in the Assets tab."
    >
      {present.length === 0 ? (
        <p className="font-brand-body text-sm text-brand-content-muted">
          No approved marks yet. Upload a wordmark, logo, or chop in the Assets tab and approve it
          to see it here.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {present.map((mark) => (
            <figure
              key={mark.kind}
              className="rounded-lg border border-brand-line overflow-hidden"
            >
              <div className="flex items-center justify-center bg-brand-surface p-10 min-h-40">
                {/* eslint-disable-next-line @next/next/no-img-element -- approved brand asset from Storage */}
                <img src={mark.url!} alt={mark.label} className="max-h-24 max-w-full w-auto" />
              </div>
              <figcaption className="border-t border-brand-line px-3 py-2 font-brand-body text-2xs uppercase tracking-wide text-brand-content-muted">
                {mark.label}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </GuideSection>
  );
}
