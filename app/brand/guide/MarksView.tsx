import type { BrandCanon } from "@/lib/brand/canon.types";
import GuideSection, { KICKER } from "./GuideSection";

export interface MarkArtifact {
  kind: string;
  label: string;
  url: string | null;
}

type MarkSpec = NonNullable<BrandCanon["marks"]>[number];
type MarkVariant = MarkSpec["variants"][number];

const MARK_LABEL: Record<string, string> = {
  wordmark: "Wordmark",
  logo: "Logo",
  chop: "Chop",
  chop_glyph: "Chop",
};

/** Marcellus stand-in used until a vector artifact is approved (per the sheet's note). */
function WordmarkStandIn({ brandName, orientation }: { brandName: string; orientation?: string }) {
  const letters = brandName.toUpperCase();
  if (orientation === "vertical") {
    return (
      <div className="flex flex-col items-center leading-[0.9]">
        {letters.split("").map((ch, i) => (
          <span key={i} className="font-brand-display text-5xl sm:text-6xl text-brand-primary">
            {ch}
          </span>
        ))}
      </div>
    );
  }
  return (
    <span className="font-brand-display text-5xl sm:text-6xl tracking-[0.05em] text-brand-primary">
      {letters}
    </span>
  );
}

function VariantCell({
  variant,
  artifactUrl,
  brandName,
  className,
}: {
  variant: MarkVariant;
  artifactUrl: string | null;
  brandName: string;
  className?: string;
}) {
  return (
    <div className={`p-6 sm:p-10 ${className ?? ""}`}>
      <p className={`${KICKER} !text-brand-accent`}>{variant.code}</p>
      {variant.cut && (
        <p className="font-brand-body text-sm text-brand-content-muted mt-1">{variant.cut}</p>
      )}
      <div className="my-10 flex items-center justify-center min-h-32">
        {artifactUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- approved brand asset from Storage
          <img src={artifactUrl} alt={variant.code} className="max-h-32 max-w-full w-auto" />
        ) : (
          <WordmarkStandIn brandName={brandName} orientation={variant.orientation} />
        )}
      </div>
      <dl className="grid grid-cols-[6rem_1fr] gap-x-4 gap-y-2 font-brand-body text-sm">
        {variant.specs.map((s, i) => (
          <div key={i} className="contents">
            <dt className="font-semibold text-brand-high-contrast">{s.key}</dt>
            <dd className="text-brand-content">{s.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Full specification sheet for one mark — mirrors the founder's wordmark sheet. */
function MarkSheet({
  spec,
  artifactUrl,
  brandName,
}: {
  spec: MarkSpec;
  artifactUrl: string | null;
  brandName: string;
}) {
  const eyebrow = [spec.status, MARK_LABEL[spec.kind] ?? spec.kind]
    .filter(Boolean)
    .join(" · ")
    .toUpperCase();

  return (
    <article className="rounded-xl border border-brand-line overflow-hidden">
      {/* Header band */}
      <header className="bg-brand-primary text-brand-on-primary px-6 sm:px-10 py-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="font-brand-body text-2xs font-semibold uppercase tracking-wide text-brand-on-primary/70">
              {eyebrow}
            </p>
            <h3 className="font-brand-display text-3xl sm:text-4xl mt-2">{spec.title}</h3>
          </div>
          {(spec.approved || (spec.summary?.length ?? 0) > 0) && (
            <div className="text-right font-brand-body text-xs text-brand-on-primary/70 space-y-0.5">
              {spec.approved && <p>{spec.approved}</p>}
              {spec.summary?.map((line, i) => <p key={i}>{line}</p>)}
            </div>
          )}
        </div>
      </header>

      {/* Variants */}
      <div className="grid md:grid-cols-2 bg-brand-canvas">
        {spec.variants.map((variant, i) => (
          <VariantCell
            key={i}
            variant={variant}
            artifactUrl={i === 0 ? artifactUrl : null}
            brandName={brandName}
            className={i > 0 ? "border-t md:border-t-0 md:border-l border-brand-line" : ""}
          />
        ))}
      </div>

      {/* Colour / clearspace / one rule */}
      {((spec.colors?.length ?? 0) > 0 ||
        (spec.clearspace?.length ?? 0) > 0 ||
        (spec.oneRule?.length ?? 0) > 0) && (
        <div className="grid md:grid-cols-3 border-t border-brand-line">
          {spec.colors?.length ? (
            <div className="p-6 bg-brand-canvas">
              <p className={`${KICKER} !text-brand-accent mb-3`}>Colour</p>
              <ul className="flex flex-col gap-2">
                {spec.colors.map((c) => (
                  <li key={c.hex} className="flex items-center gap-2">
                    <span
                      className="h-6 w-10 shrink-0 rounded border border-brand-line"
                      style={{ background: c.hex }}
                    />
                    <span className="font-brand-body text-xs text-brand-content">
                      {c.name} <span className="text-brand-content-muted">{c.hex}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {spec.clearspace?.length ? (
            <div className="p-6 bg-brand-canvas border-t md:border-t-0 md:border-l border-brand-line">
              <p className={`${KICKER} !text-brand-accent mb-3`}>Clearspace &amp; scale</p>
              <div className="flex flex-col gap-2 font-brand-body text-sm text-brand-content">
                {spec.clearspace.map((line, i) => <p key={i}>{line}</p>)}
              </div>
            </div>
          ) : null}
          {spec.oneRule?.length ? (
            <div className="p-6 bg-brand-primary text-brand-on-primary border-t md:border-t-0 md:border-l border-brand-line">
              <p className="font-brand-body text-2xs font-semibold uppercase tracking-wide text-brand-on-primary/70 mb-3">
                The one rule
              </p>
              <div className="flex flex-col gap-2 font-brand-body text-sm">
                {spec.oneRule.map((line, i) => <p key={i}>{line}</p>)}
              </div>
            </div>
          ) : null}
        </div>
      )}

      {spec.note && (
        <p className="border-t border-brand-line px-6 py-3 font-brand-body text-xs text-brand-content-muted">
          {spec.note}
        </p>
      )}
    </article>
  );
}

/**
 * Marks view: full specification sheets for marks defined in canon (wordmark
 * today), plus compact cards for any approved artifact that has no sheet yet
 * (logo/chop). Artifacts are resolved from the approved Assets library; specs
 * come from canon.marks. Upload/approve artifacts in the Assets tab.
 */
export default function MarksView({
  brandName,
  marks,
  specs,
  intro,
}: {
  brandName: string;
  marks: MarkArtifact[];
  specs: MarkSpec[];
  intro: string;
}) {
  const urlByKind = new Map(marks.map((m) => [m.kind, m.url]));
  // chop_glyph is the asset kind; the mark spec uses "chop".
  const artifactFor = (kind: string) =>
    urlByKind.get(kind) ?? (kind === "chop" ? urlByKind.get("chop_glyph") ?? null : null);

  const speccedKinds = new Set<string>(specs.map((s) => s.kind));
  // Approved artifacts with no spec sheet yet → compact cards.
  const looseArtifacts = marks.filter(
    (m) => m.url && !speccedKinds.has(m.kind) && !(m.kind === "chop_glyph" && speccedKinds.has("chop")),
  );

  return (
    <GuideSection intro={intro}>
      {specs.length === 0 && looseArtifacts.length === 0 ? (
        <p className="font-brand-body text-sm text-brand-content-muted">
          No marks yet. In Edit mode, admins can upload a wordmark, logo, or chop and define its
          specification sheet.
        </p>
      ) : (
        <div className="flex flex-col gap-8">
          {specs.map((spec, i) => (
            <MarkSheet key={i} spec={spec} artifactUrl={artifactFor(spec.kind)} brandName={brandName} />
          ))}

          {looseArtifacts.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {looseArtifacts.map((mark) => (
                <figure key={mark.kind} className="rounded-lg border border-brand-line overflow-hidden">
                  <div className="flex items-center justify-center bg-brand-surface p-10 min-h-40">
                    {/* eslint-disable-next-line @next/next/no-img-element -- approved brand asset from Storage */}
                    <img src={mark.url!} alt={mark.label} className="max-h-24 max-w-full w-auto" />
                  </div>
                  <figcaption className="border-t border-brand-line px-3 py-2 font-brand-body text-2xs uppercase tracking-wide text-brand-content-muted">
                    {MARK_LABEL[mark.kind] ?? mark.label} · specification pending
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </div>
      )}
    </GuideSection>
  );
}
