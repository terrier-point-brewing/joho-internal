"use client";

import { useState } from "react";
import type { BrandCanon } from "@/lib/brand/canon.types";
import type { BrandAsset } from "@/lib/brand/assets";
import type { BrandSeason } from "@/lib/brand/seasons";
import { groupChopsBySeason, groupVariations, type MarkVariation } from "@/lib/brand/marks";
import { normalizeRules, splitByPolarity } from "@/lib/brand/guideRules";
import type { ArtworkGround } from "@/lib/brand/svgColor";
import ButtonGroup from "@/app/components/ButtonGroup";
import SubHead from "./blocks/SubHead";
import SpecCard, { type SpecRow } from "./blocks/SpecCard";
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
 * The written rules for a mark family, folded into the one card a reader
 * needs — the boundaries every cut is chosen within (frame, orientation,
 * valid colors), clearspace, the one rule that decides between cuts, and any
 * do/don't guidance — rather than a run of separate labeled blocks above a
 * spec card. Wordmarks and chops render the exact same shape, so the two
 * sections read as siblings instead of the wordmark carrying more prose than
 * the chop does.
 *
 * These stay in the canon rather than moving onto the assets: "never show both
 * J's in one lockup" is a statement about the mark, not about any one file of
 * it, and it has to survive every variation being re-uploaded.
 */
function MarkSpecCard({ spec }: { spec: MarkSpec }) {
  const { dos, donts } = splitByPolarity(normalizeRules(spec.usage, "do"));
  const rows: SpecRow[] = [];

  // Wordmarks skip a status row — the card title already headers the
  // section, so a second name/status/approved line would just repeat it.
  if (spec.kind !== "wordmark" && (spec.status || spec.approved)) {
    rows.push({ label: "Status", value: [spec.status, spec.approved].filter(Boolean).join(" — ") });
  }
  for (const s of spec.specs ?? []) rows.push({ label: s.key, value: s.value });
  if (dos.length > 0) rows.push({ label: "Do", value: dos.map((r) => r.title).join(" · ") });
  if (donts.length > 0) {
    rows.push({ label: "Don't", value: donts.map((r) => r.title).join(" · "), tone: "accent" });
  }
  if ((spec.clearspace?.length ?? 0) > 0) {
    rows.push({ label: "Clearspace & scale", value: spec.clearspace!.join(" ") });
  }
  if ((spec.oneRule?.length ?? 0) > 0) {
    rows.push({ label: "The one rule", value: spec.oneRule!.join(" ") });
  }

  if (rows.length === 0 && !spec.note) return null;

  return (
    <SpecCard
      title={spec.kind === "wordmark" ? "Wordmark specification" : spec.title || "Mark specification"}
      tag={spec.kind === "wordmark" ? "Every wordmark" : undefined}
      rows={rows}
      footer={spec.note}
    />
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
  variation,
  grounds,
  primary,
}: {
  variation: MarkVariation;
  grounds: Record<string, ArtworkGround>;
  primary: boolean;
}) {
  // The warning is about the chop, not about one of its files: a chop that
  // ships a vector alongside a PNG is a vector chop, and flagging the PNG
  // would read as a defect in a variation that has none.
  const vectorless = !variation.files.some((f) => f.format.toLowerCase() === "svg");

  return (
    <div className="rounded-lg border border-brand-line p-3 flex flex-col gap-3">
      <MarkArtwork
        assets={variation.files}
        alt={variation.label}
        grounds={grounds}
        aspect="aspect-square"
      />

      <div>
        <div className="flex items-baseline justify-between gap-2">
          <p className="font-brand-body text-sm font-semibold text-brand-high-contrast">
            {variation.label}
          </p>
          {primary && (
            <span className="font-brand-body text-2xs uppercase tracking-wide text-brand-primary shrink-0">
              In use
            </span>
          )}
        </div>
        {vectorless && (
          <p className="font-brand-body text-2xs uppercase tracking-wide text-brand-accent mt-0.5">
            Not a vector — {variation.files.map((f) => f.format).join(", ")}
          </p>
        )}
      </div>

      {variation.description ? (
        <p className="font-brand-body text-xs text-brand-content leading-relaxed">
          {variation.description}
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
 * is a grid of variation cards, sitting under its one specification card: the
 * short list of what is allowed to vary, since a wordmark is otherwise fixed.
 *
 * A chop is cut per season against a fixed specification: same color, same
 * frame, different content. So the specification comes first, and the chops
 * below it are grouped by the season that claims them, with the seasonless ones
 * standing as the generic fallback.
 *
 * Wordmarks and Chops are button-tabs beneath the intro (see Settings → Tax
 * Filing for the same pattern) rather than two sections stacked on one page —
 * a reader after the chop shouldn't have to scroll past every wordmark
 * variation to reach it. Each tab's written rules collapse into the one
 * specification card (`MarkSpecCard`), never a run of separate blocks above
 * it, so the two tabs read as siblings.
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
  /** The chop's narrative and specification — the law every chop is cut to. */
  chop?: BrandCanon["chop"];
}) {
  const [tab, setTab] = useState<"wordmarks" | "chops">("wordmarks");

  const variations = groupVariations(wordmarks);
  const chopGroups = groupChopsBySeason(chops, seasons);

  const wordmarkSpecs = specs.filter((s) => s.kind === "wordmark");
  const chopSpecs = specs.filter((s) => s.kind === "chop");
  const chopRows: SpecRow[] = (chop?.specs ?? []).map((s) => ({ label: s.key, value: s.value }));

  return (
    <div className="flex flex-col gap-6">
      <ButtonGroup
        tabs={[
          { key: "wordmarks", label: "Wordmarks" },
          { key: "chops", label: "Chops" },
        ]}
        activeKey={tab}
        onSelect={setTab}
      />

      {tab === "wordmarks" && (
        <section>
          <SubHead
            title="Wordmarks"
            description="The name set as type — one drawing, cut into variations. The variations differ only in proportion, ink and ground; pick by where it has to sit, never by taste."
          />
          {wordmarkSpecs.length > 0 && (
            <div className="flex flex-col gap-3 mb-4">
              {wordmarkSpecs.map((spec, i) => (
                <MarkSpecCard key={spec.id ?? i} spec={spec} />
              ))}
            </div>
          )}
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
      )}

      {tab === "chops" && (
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
          {(chopRows.length > 0 || chopSpecs.length > 0) && (
            <div className="flex flex-col gap-3 mb-4">
              {chopRows.length > 0 && (
                <SpecCard
                  title="Chop specification"
                  tag="Every chop"
                  rows={chopRows}
                  footer="Every chop below is cut to these. A chop that misses one is not a chop."
                />
              )}
              {chopSpecs.map((spec, i) => (
                <MarkSpecCard key={spec.id ?? i} spec={spec} />
              ))}
            </div>
          )}

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
                    {group.chops.map((variation) => (
                      <ChopCard
                        key={variation.key}
                        variation={variation}
                        grounds={grounds}
                        primary={variation.files.some((f) => f.id === group.primaryAssetId)}
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
      )}
    </div>
  );
}
