import type { BrandAsset } from "@/lib/brand/assets";
import type { RulePanel } from "@/lib/brand/rulePairs";
import AssetImage from "./AssetImage";

/** One panel's content, with its asset already resolved by the caller. */
export interface ResolvedPanel extends RulePanel {
  asset?: BrandAsset;
}

/**
 * One rule, shown as the pair it actually is: the thing to do beside the
 * specific failure it exists to prevent, then why the rule exists at all.
 *
 * The pair is a two-column GRID, not two floated cards, and each panel is
 * `h-full`. That is the whole reason this component exists: as two independent
 * lists, a do and its don't sat at different heights on the page and drifted
 * further apart with every rule above them, so the reader had to hunt for the
 * matching prohibition. Grid stretch makes both halves of a pair start on the
 * same line and end on the same line, whichever one has more to say.
 *
 * Below `sm` the pair stacks instead of narrowing. Two 4:3 image slots side by
 * side on a phone are each too small to read, and the comparison is worth more
 * than the adjacency.
 *
 * The panels take no `polarity` field: which side is which is fixed by
 * position — affirmative left, prohibition right — across every card, so a
 * reader can scan one column the whole way down.
 */
export default function RulePairCard({
  title,
  doPanel,
  dontPanel,
  nuance,
}: {
  title: string;
  doPanel: ResolvedPanel;
  dontPanel: ResolvedPanel;
  /** Why the rule exists — full card width, beneath both panels. */
  nuance?: string;
}) {
  return (
    <article className="rounded-lg border border-brand-line p-4 sm:p-5">
      <h3 className="font-brand-display text-base sm:text-lg text-brand-high-contrast leading-snug">
        {title}
      </h3>

      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Panel tone="do" label="Do" panel={doPanel} title={title} />
        <Panel tone="dont" label="Don't" panel={dontPanel} title={title} />
      </div>

      {nuance && (
        <p className="mt-3 pt-3 border-t border-brand-line font-brand-body text-sm text-brand-content leading-relaxed">
          {nuance}
        </p>
      )}
    </article>
  );
}

// Status tints, not brand tints. The brand's own affirmative color is `primary`,
// which flips to paper-cream in the dark skin — the same value as body text — so
// a do panel drawn from the palette would be indistinguishable from a don't in
// half the themes. The success/danger ramps are the one set of colors
// deliberately held outside the palette (lib/brand/opsThemeMap.ts) precisely
// because green-means-yes has to survive a rebrand, and they carry their own
// light and dark values.
//
// Full-strength surface, not a fraction of one: the light ramp is already a
// `-50` tint, and knocking it back further (the `/40` the rest of the app uses)
// leaves both halves the same warm paper as the page.
const TONES = {
  do: "bg-success-surface border-success-border text-success",
  dont: "bg-danger-surface border-danger-border text-danger",
} as const;

function Panel({
  tone,
  label,
  panel,
  title,
}: {
  tone: keyof typeof TONES;
  label: string;
  panel: ResolvedPanel;
  /** The rule, used as the alt-text fallback when nothing better is authored. */
  title: string;
}) {
  return (
    // h-full is what equalises the two halves: the grid row stretches to the
    // taller panel, and this makes the shorter one fill it rather than leaving
    // a tinted block that stops halfway down its own row.
    <div className={`h-full flex flex-col rounded-md border p-3 ${TONES[tone]}`}>
      <p className="font-brand-body text-2xs font-semibold uppercase tracking-[0.14em]">{label}</p>

      <div className="mt-2">
        <AssetImage
          assetId={panel.assetId}
          asset={panel.asset}
          alt={panel.brief || panel.caption || title}
          aspect="4/3"
          pendingNote={panel.brief}
        />
      </div>

      {panel.caption ? (
        <p className="font-brand-body text-sm mt-2 leading-relaxed">{panel.caption}</p>
      ) : (
        <p className="font-brand-body text-sm mt-2 leading-relaxed text-brand-content-muted italic">
          Not written yet
        </p>
      )}
    </div>
  );
}
