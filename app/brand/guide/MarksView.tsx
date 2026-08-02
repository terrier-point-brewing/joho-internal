import type { BrandCanon } from "@/lib/brand/canon.types";
import type { BrandAsset } from "@/lib/brand/assets";
import type { BrandSeason } from "@/lib/brand/seasons";
import { groupChopsBySeason, groupVariations, type MarkVariation } from "@/lib/brand/marks";
import { normalizeRules, splitByPolarity } from "@/lib/brand/guideRules";
import type { ArtworkGround } from "@/lib/brand/svgColor";
import GuideSection from "./GuideSection";
import SubHead from "./blocks/SubHead";
import SpecCard from "./blocks/SpecCard";
import MarkArtwork from "./blocks/MarkArtwork";

type MarkSpec = NonNullable<BrandCanon["marks"]>[number];

const SHAPE_LABEL: Record<NonNullable<BrandAsset["shape"]>, string> = {
  square: "Square",
  rectangular: "Rectangular",
  other: "Irregular",
};

const ORIENTATION_LABEL: Record<NonNullable<BrandAsset["orientation"]>, string> = {
  horizontal: "Horizontal",
  vertical: "Vertical",
};

/** A facet, shown only when the uploader declared one. */
function Facet({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <span className="font-brand-body text-2xs uppercase tracking-wide rounded-full border border-brand-line-strong px-2 py-0.5 text-brand-content-muted">
      <span className="text-brand-content-muted/70">{label} </span>
      {value}
    </span>
  );
}

/**
 * The written rules for a mark family — everything about it that is prose
 * rather than a file.
 *
 * These stay in the canon rather than moving onto the assets: "never show both
 * J's in one lockup" is a statement about the mark, not about any one file of
 * it, and it has to survive every variation being re-uploaded.
 */
function MarkRules({ spec }: { spec: MarkSpec }) {
  const { dos, donts } = splitByPolarity(normalizeRules(spec.usage, "do"));
  const specRows = spec.specs ?? [];
  const hasBody =
    dos.length > 0 ||
    donts.length > 0 ||
    (spec.clearspace?.length ?? 0) > 0 ||
    (spec.oneRule?.length ?? 0) > 0;

  if (!hasBody && specRows.length === 0 && !spec.note) return null;

  return (
    <div className="flex flex-col gap-3 mb-4">
      {spec.title && (
        <p className="font-brand-display text-lg text-brand-high-contrast">
          {spec.title}
          {spec.status && (
            <span className="font-brand-body text-2xs uppercase tracking-wide text-brand-content-muted ml-2">
              {spec.status}
            </span>
          )}
          {spec.approved && (
            <span className="font-brand-body text-2xs text-brand-content-muted ml-2">
              {spec.approved}
            </span>
          )}
        </p>
      )}

      {(dos.length > 0 || donts.length > 0) && (
        <div className="flex flex-col gap-1">
          {dos.map((rule) => (
            <p key={rule.id} className="font-brand-body text-sm text-brand-primary leading-relaxed">
              ✓ {rule.title}
            </p>
          ))}
          {donts.map((rule) => (
            <p key={rule.id} className="font-brand-body text-sm text-brand-accent leading-relaxed">
              ✕ {rule.title}
            </p>
          ))}
        </div>
      )}

      {(spec.clearspace?.length ?? 0) > 0 && (
        <div>
          <p className="font-brand-body text-2xs uppercase tracking-wide text-brand-content-muted mb-0.5">
            Clearspace &amp; scale
          </p>
          {spec.clearspace!.map((line, i) => (
            <p key={i} className="font-brand-body text-sm text-brand-content leading-relaxed">
              {line}
            </p>
          ))}
        </div>
      )}

      {(spec.oneRule?.length ?? 0) > 0 && (
        <div>
          <p className="font-brand-body text-2xs uppercase tracking-wide text-brand-content-muted mb-0.5">
            The one rule
          </p>
          {spec.oneRule!.map((line, i) => (
            <p key={i} className="font-brand-body text-sm text-brand-content leading-relaxed">
              {line}
            </p>
          ))}
        </div>
      )}

      {/* The mark's own spec sheet — the boundaries every cut is chosen
          within (frame, orientation, valid color combinations). One card,
          same as the chop's: a wordmark is largely fixed, so what a reader
          needs is the short list of what varies, not a sheet per cut. */}
      {specRows.length > 0 && (
        <SpecCard
          title={spec.kind === "wordmark" ? "Wordmark specification" : "Mark specification"}
          tag={spec.kind === "wordmark" ? "Every wordmark" : undefined}
          rows={specRows.map((s) => ({ label: s.key, value: s.value }))}
        />
      )}

      {spec.note && (
        <p className="font-brand-body text-2xs text-brand-content-muted">{spec.note}</p>
      )}
    </div>
  );
}

/**
 * One wordmark variation.
 *
 * Every variation is the same wordmark; what a reader has to be able to tell at
 * a glance is which one to reach for. So the card leads with the artwork, names
 * the variation, states the ways it differs (orientation, shape, ink, ground),
 * and closes with the sentence saying when to use it.
 */
function VariationCard({
  variation,
  grounds,
}: {
  variation: MarkVariation;
  grounds: Record<string, ArtworkGround>;
}) {
  return (
    <div className="rounded-lg border border-brand-line p-3 flex flex-col gap-3">
      <MarkArtwork assets={variation.files} alt={variation.label} grounds={grounds} />

      <div>
        <p className="font-brand-body text-sm font-semibold text-brand-high-contrast">
          {variation.label}
        </p>
        {(variation.orientation ||
          variation.shape ||
          variation.colorTreatment ||
          variation.background) && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            <Facet
              label="Orientation"
              value={variation.orientation ? ORIENTATION_LABEL[variation.orientation] : null}
            />
            <Facet label="Shape" value={variation.shape ? SHAPE_LABEL[variation.shape] : null} />
            <Facet label="Ink" value={variation.colorTreatment} />
            <Facet
              label="Ground"
              value={
                variation.background?.toLowerCase() === "none"
                  ? "No background"
                  : variation.background
              }
            />
          </div>
        )}
      </div>

      {variation.description && (
        <p className="font-brand-body text-xs text-brand-content leading-relaxed">
          {variation.description}
        </p>
      )}
    </div>
  );
}

/**
 * One chop.
 *
 * Square box, deliberately: the canon's chop specification fixes the footprint
 * at a 1:1–1:1.15 square, and a chop shown in a 16:9 letterbox reads as a mark
 * with room around it that it does not have.
 */
function ChopCard({
  asset,
  grounds,
  primary,
}: {
  asset: BrandAsset;
  grounds: Record<string, ArtworkGround>;
  primary: boolean;
}) {
  return (
    <div className="rounded-lg border border-brand-line p-3 flex flex-col gap-3">
      <MarkArtwork
        assets={[asset]}
        alt={asset.title || asset.variant}
        grounds={grounds}
        aspect="aspect-square"
      />

      <div>
        <div className="flex items-baseline justify-between gap-2">
          <p className="font-brand-body text-sm font-semibold text-brand-high-contrast">
            {asset.title || asset.variant}
          </p>
          {primary && (
            <span className="font-brand-body text-2xs uppercase tracking-wide text-brand-primary shrink-0">
              In use
            </span>
          )}
        </div>
        {asset.format.toLowerCase() !== "svg" && (
          <p className="font-brand-body text-2xs uppercase tracking-wide text-brand-accent mt-0.5">
            Not a vector — {asset.format}
          </p>
        )}
      </div>

      {asset.description ? (
        <p className="font-brand-body text-xs text-brand-content leading-relaxed">
          {asset.description}
        </p>
      ) : (
        <p className="font-brand-body text-xs text-brand-content-muted leading-relaxed">
          No content description yet.
        </p>
      )}
    </div>
  );
}

/**
 * Marks view: the wordmark and the chop, each shown the way it actually varies.
 *
 * A wordmark is one drawing shipped in variations — horizontal or vertical,
 * square or rectangular, one ink or another, on a ground or on nothing — so it
 * is a grid of variation cards, each naming its facets and saying when to
 * reach for it. Above the grid sits the wordmark's own specification: the
 * short list of what is allowed to vary, since a wordmark is otherwise fixed.
 *
 * A chop is cut per season against a fixed specification: same color, same
 * frame, different content. So the specification comes first, and the chops
 * below it are grouped by the season that claims them, with the seasonless ones
 * standing as the generic fallback.
 *
 * Cards are built from approved assets rather than from canon JSON. They were
 * canon `marks[].variants[]` until this rework, which made every new chop a
 * two-step act — upload the file, then go author a variant to hang it on — and
 * gave a reader nowhere to record the season or the content. What stays in the
 * canon is what is genuinely prose: the usage rules, the clearspace law, and
 * the chop's own specification sheet.
 *
 * Everything sits flat on the card — no click-to-reveal, except the switch
 * between a variation's SVG and its PNG, which is a choice of file rather than
 * hidden content.
 */
export default function MarksView({
  specs,
  wordmarks,
  chops,
  seasons,
  grounds,
  intro,
  chop,
}: {
  /** Canon mark specs — the written rules, keyed by kind. */
  specs: MarkSpec[];
  /** Approved wordmark assets. */
  wordmarks: BrandAsset[];
  /** Approved chop assets. */
  chops: BrandAsset[];
  /** Every season, newest first — the groups the chops fall into. */
  seasons: BrandSeason[];
  /** Per-asset background choice, read from the artwork itself. */
  grounds: Record<string, ArtworkGround>;
  intro: string;
  /** The chop's narrative and specification — the law every chop is cut to. */
  chop?: BrandCanon["chop"];
}) {
  const variations = groupVariations(wordmarks);
  const chopGroups = groupChopsBySeason(chops, seasons);

  const wordmarkSpecs = specs.filter((s) => s.kind === "wordmark");
  const chopSpecs = specs.filter((s) => s.kind === "chop");
  const chopRows = (chop?.specs ?? []).map((s) => ({ label: s.key, value: s.value }));

  return (
    <GuideSection section="marks" intro={intro}>
      <div className="flex flex-col gap-8">
        <section>
          <SubHead
            title="Wordmarks"
            description="The name set as type — one drawing, cut into variations. The variations differ only in proportion, ink and ground; pick by where it has to sit, never by taste."
          />
          {wordmarkSpecs.map((spec, i) => (
            <MarkRules key={spec.id ?? i} spec={spec} />
          ))}
          {variations.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {variations.map((variation) => (
                <VariationCard
                  key={variation.key}
                  variation={variation}
                  grounds={grounds}
                />
              ))}
            </div>
          ) : (
            <p className="font-brand-body text-sm text-brand-content-muted">
              No wordmark variations yet. In Edit mode, admins can upload one and describe how it
              varies.
            </p>
          )}
        </section>

        <section>
          <SubHead
            title="Chops"
            description="The seal. The last mark read, and never the first. Color and frame are fixed by the specification below; only the content rotates, season by season."
          />

          {chop?.narrative && (
            <p className="font-brand-body text-sm text-brand-content leading-relaxed mb-3">
              {chop.narrative}
            </p>
          )}
          {chopRows.length > 0 && (
            <div className="mb-4">
              <SpecCard
                title="Chop specification"
                tag="Every chop"
                rows={chopRows}
                footer="Every chop below is cut to these. A chop that misses one is not a chop."
              />
            </div>
          )}
          {chopSpecs.map((spec, i) => (
            <MarkRules key={spec.id ?? i} spec={spec} />
          ))}

          {chopGroups.length > 0 ? (
            <div className="flex flex-col gap-5">
              {chopGroups.map((group) => (
                <div key={group.seasonId ?? "generic"}>
                  <p className="font-brand-body text-xs font-semibold uppercase tracking-wide text-brand-content-muted mb-2">
                    {group.seasonName}
                    <span className="font-normal normal-case tracking-normal ml-2 text-brand-content-muted/70">
                      {group.generic
                        ? "Seasonless — the fallback when no season claims a chop."
                        : `${group.chops.length} chop${group.chops.length === 1 ? "" : "s"}`}
                    </span>
                  </p>
                  <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
                    {group.chops.map((asset) => (
                      <ChopCard
                        key={asset.id}
                        asset={asset}
                        grounds={grounds}
                        primary={asset.id === group.primaryAssetId}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="font-brand-body text-sm text-brand-content-muted">
              No chops yet. In Edit mode, admins can upload one and attach it to a season — or leave
              it seasonless as the generic chop.
            </p>
          )}
        </section>
      </div>
    </GuideSection>
  );
}
