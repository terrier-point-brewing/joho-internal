import type { BrandCanon } from "@/lib/brand/canon.types";
import type { BrandAsset } from "@/lib/brand/assets";
import { normalizeRules, splitByPolarity } from "@/lib/brand/guideRules";
import type { ArtworkGround } from "@/lib/brand/svgColor";
import GuideSection from "./GuideSection";
import SubHead from "./blocks/SubHead";
import SpecCard from "./blocks/SpecCard";
import MarkArtwork from "./blocks/MarkArtwork";

type MarkSpec = NonNullable<BrandCanon["marks"]>[number];
type MarkVariant = MarkSpec["variants"][number];

/** The three identity families, in the order the guide presents them. */
const SECTIONS: { kind: MarkSpec["kind"]; title: string; description: string }[] = [
  {
    kind: "wordmark",
    title: "Wordmarks",
    description: "The name set as type. The default identity on anything with room for it.",
  },
  {
    kind: "chop",
    title: "Chops",
    description: "The seal. The last mark read, and never the first.",
  },
  {
    kind: "logo",
    title: "Logos",
    description: "Combination marks — wordmark and chop locked together.",
  },
];

/** One cut of a mark: its artwork, what it's for, how it may be used, its specs. */
function MarkCard({
  spec,
  variant,
  assets,
  grounds,
}: {
  spec: MarkSpec;
  variant: MarkVariant;
  assets: BrandAsset[];
  grounds: Map<string, ArtworkGround>;
}) {
  const { dos, donts } = splitByPolarity(normalizeRules(spec.usage, "do"));

  return (
    <div className="rounded-lg border border-brand-line p-3 flex flex-col gap-3">
      <MarkArtwork
        assets={assets}
        alt={variant.code}
        ground={assets.length > 0 ? (grounds.get(assets[0].id) ?? "neutral") : "neutral"}
      />

      <div>
        <div className="flex items-baseline justify-between gap-2">
          <p className="font-brand-body text-sm font-semibold text-brand-high-contrast">
            {variant.code}
          </p>
          {spec.status && (
            <span className="font-brand-body text-2xs uppercase tracking-wide text-brand-content-muted shrink-0">
              {spec.status}
            </span>
          )}
        </div>
        {variant.cut && (
          <p className="font-brand-body text-xs text-brand-content-muted mt-0.5">{variant.cut}</p>
        )}
      </div>

      {(dos.length > 0 || donts.length > 0) && (
        <div className="flex flex-col gap-1">
          {dos.map((rule) => (
            <p key={rule.id} className="font-brand-body text-xs text-brand-primary leading-relaxed">
              ✓ {rule.title}
            </p>
          ))}
          {donts.map((rule) => (
            <p key={rule.id} className="font-brand-body text-xs text-brand-accent leading-relaxed">
              ✕ {rule.title}
            </p>
          ))}
        </div>
      )}

      {variant.specs.length > 0 && (
        <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1">
          {variant.specs.map((s, i) => (
            <div key={i} className="contents">
              <dt className="font-brand-body text-2xs uppercase tracking-wide text-brand-content-muted">
                {s.key}
              </dt>
              <dd className="font-brand-body text-xs text-brand-content">{s.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {spec.clearspace && spec.clearspace.length > 0 && (
        <div>
          <p className="font-brand-body text-2xs uppercase tracking-wide text-brand-content-muted mb-0.5">
            Clearspace &amp; scale
          </p>
          {spec.clearspace.map((line, i) => (
            <p key={i} className="font-brand-body text-xs text-brand-content leading-relaxed">
              {line}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/** A mark's `kind` uses "chop"; the asset library calls the same thing "chop_glyph". */
const ASSET_KIND_FOR_MARK: Record<MarkSpec["kind"], string> = {
  wordmark: "wordmark",
  logo: "logo",
  chop: "chop_glyph",
};

/**
 * Marks view: the identity artifacts, grouped into Wordmarks, Chops and Logos.
 *
 * Every cut gets its own card carrying its artwork, what it's for, how it may
 * and may not be used, and a download per format. Previously this rendered one
 * hand-built specification sheet and resolved exactly three hardcoded asset
 * lookups (`kind` + `variant="default"`), so adding a second wordmark cut was a
 * code change rather than an upload.
 *
 * Everything sits flat on the card — no click-to-reveal. Three sections of
 * these make a long page, and that is the right trade: a spec sheet you scroll
 * beats one you have to interrogate.
 */
export default function MarksView({
  specs,
  assets,
  grounds,
  intro,
  chop,
}: {
  specs: MarkSpec[];
  /** Approved assets — variants reference these by id. */
  assets: BrandAsset[];
  /** Per-asset background choice, read from the artwork itself. */
  grounds: Map<string, ArtworkGround>;
  intro: string;
  /**
   * The chop's narrative and spec sheet. Rendered here from Phase A on: the
   * chop IS a mark, but its rules lived in their own canon key that no view
   * read, so the placement and footprint law a label is built against appeared
   * nowhere in the guide.
   */
  chop?: BrandCanon["chop"];
}) {
  const assetById = new Map(assets.map((a) => [a.id, a]));

  /**
   * A variant's artwork.
   *
   * Explicit `assetIds` win. When a variant has none, approved assets of the
   * matching kind are shown instead — otherwise uploading and approving a
   * wordmark changed nothing on screen until someone also went and attached it
   * to a specific cut, which reads as the upload having silently failed.
   */
  const assetsFor = (spec: MarkSpec, variant: MarkVariant): BrandAsset[] => {
    const explicit = (variant.assetIds ?? [])
      .map((id) => assetById.get(id))
      .filter((a): a is BrandAsset => !!a);
    if (explicit.length > 0) return explicit;

    const kind = ASSET_KIND_FOR_MARK[spec.kind];
    return assets.filter((a) => a.kind === kind);
  };

  const sections = SECTIONS.map((section) => ({
    ...section,
    marks: specs.filter((s) => s.kind === section.kind),
  })).filter((section) => section.marks.length > 0);

  const chopRows = (chop?.specs ?? []).map((s) => ({ label: s.key, value: s.value }));
  const chopBlock = (chop?.narrative || chopRows.length > 0) && (
    <section>
      <SubHead
        title="The chop — specification"
        description="Placement, footprint, color and content. Fixed across every release; only the glyph rotates."
      />
      {chop?.narrative && (
        <p className="font-brand-body text-sm text-brand-content leading-relaxed mb-3">
          {chop.narrative}
        </p>
      )}
      {chopRows.length > 0 && <SpecCard title="Chop specification" rows={chopRows} />}
    </section>
  );

  if (sections.length === 0) {
    return (
      <GuideSection intro={intro}>
        {chopBlock || (
          <p className="font-brand-body text-sm text-brand-content-muted">
            No marks yet. In Edit mode, admins can define a wordmark, chop or logo and attach its
            artwork.
          </p>
        )}
      </GuideSection>
    );
  }

  return (
    <GuideSection intro={intro}>
      <div className="flex flex-col gap-8">
        {chopBlock}
        {sections.map((section) => (
          <section key={section.kind}>
            <SubHead title={section.title} description={section.description} />
            <div className="flex flex-col gap-6">
              {section.marks.map((spec, i) => (
                <div key={spec.id ?? i}>
                  {spec.title && (
                    <p className="font-brand-display text-lg text-brand-high-contrast mb-2">
                      {spec.title}
                      {spec.approved && (
                        <span className="font-brand-body text-2xs text-brand-content-muted ml-2">
                          {spec.approved}
                        </span>
                      )}
                    </p>
                  )}
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {spec.variants.map((variant, vi) => (
                      <MarkCard
                        key={variant.id ?? vi}
                        spec={spec}
                        variant={variant}
                        assets={assetsFor(spec, variant)}
                        grounds={grounds}
                      />
                    ))}
                  </div>
                  {spec.note && (
                    <p className="font-brand-body text-2xs text-brand-content-muted mt-2">
                      {spec.note}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </GuideSection>
  );
}
