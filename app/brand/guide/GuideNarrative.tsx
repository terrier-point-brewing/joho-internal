import type { BrandCanon } from "@/lib/brand/canon.types";
import type { BrandLabel } from "@/lib/brand/labels";
import GuideSection, { KICKER } from "./GuideSection";
import GuideToc, { type TocEntry } from "./GuideToc";

/**
 * The Guide tab's view: the narrative + rules sections (Color and Typography
 * live in their own tabs; the chop lives on the Marks tab and the label chassis
 * in Releases, so neither appears here). The page-level header + subtabs live in
 * BrandGuideTabs; this view opens straight into a sticky Contents rail (xl) and
 * the numbered sections, each filling the full content column.
 */
export default function GuideNarrative({
  canon,
  labels,
}: {
  canon: BrandCanon;
  labels: BrandLabel[];
}) {
  // Single ordered source for both the numbering and the Contents rail, so a
  // conditionally-absent section never leaves a gap in the sequence.
  const sectionMeta: { id: string; title: string; present: boolean }[] = [
    { id: "ethos", title: "Ethos", present: true },
    { id: "values", title: "Values & costs", present: (canon.values?.length ?? 0) > 0 },
    { id: "never", title: "The Never List", present: (canon.neverList?.length ?? 0) > 0 },
    { id: "voice", title: "Voice", present: true },
    { id: "naming", title: "Naming", present: true },
    { id: "illustration", title: "Illustration", present: (canon.illustrationLaw?.rules?.length ?? 0) > 0 },
    { id: "taplist", title: "Tap list", present: labels.length > 0 },
    { id: "rules", title: "Precedence & rules", present: true },
  ];
  const present = sectionMeta.filter((s) => s.present);
  const num = new Map(present.map((s, i) => [s.id, String(i + 1).padStart(2, "0")]));
  const toc: TocEntry[] = present.map((s) => ({ id: s.id, title: s.title }));

  return (
    <div className="grid gap-x-12 xl:grid-cols-[15rem_minmax(0,1fr)]">
      <GuideToc entries={toc} />

      <div className="min-w-0 flex flex-col gap-16 sm:gap-20">
        {/* Ethos — leads with the mission, then the narrative behind it */}
        <GuideSection id="ethos" num={num.get("ethos")} title="Ethos">
          <p className="font-brand-display text-2xl sm:text-4xl leading-tight text-brand-high-contrast mb-6">
            {canon.mission}
          </p>
          {canon.missionNarrative && (
            <p className="font-brand-body text-base text-brand-content leading-relaxed">
              {canon.missionNarrative}
            </p>
          )}
        </GuideSection>

        {/* Values & their costs */}
        {canon.values?.length > 0 && (
          <GuideSection
            id="values"
            num={num.get("values")}
            title="Values & costs"
            lead="What we hold — and what living by it costs us."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              {canon.values.map((v) => (
                <div key={v.n} className="rounded-lg border border-brand-line p-4">
                  <p className="font-brand-display text-lg text-brand-high-contrast">
                    {v.n}. {v.title}
                  </p>
                  <p className="font-brand-body text-sm text-brand-content mt-1">{v.means}</p>
                  <p className="font-brand-body text-xs text-brand-content-muted mt-2">
                    <span className="text-brand-accent uppercase tracking-wide">The cost · </span>
                    {v.cost}
                  </p>
                </div>
              ))}
            </div>
          </GuideSection>
        )}

        {/* The Never List */}
        {canon.neverList?.length > 0 && (
          <GuideSection id="never" num={num.get("never")} title="The Never List">
            <ul className="grid gap-x-10 gap-y-2 sm:grid-cols-2 font-brand-body text-sm text-brand-content">
              {canon.neverList.map((n, i) => (
                <li key={i} className="flex gap-2.5 leading-relaxed">
                  <span className="text-brand-accent shrink-0" aria-hidden="true">
                    —
                  </span>
                  <span>{n}</span>
                </li>
              ))}
            </ul>
          </GuideSection>
        )}

        {/* Voice */}
        <GuideSection id="voice" num={num.get("voice")} title="Voice" lead={canon.voice.summary}>
          {canon.voice.personality && (
            <p className="font-brand-body text-sm text-brand-content-muted leading-relaxed mb-6">
              {canon.voice.personality}
            </p>
          )}

          <p className={`${KICKER} mb-3`}>Calibration</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 mb-6">
            {canon.voice.sliders.map((slider, i) => (
              <div key={i} className="rounded-lg border border-brand-line p-3 font-brand-body">
                <div className="flex items-center justify-between text-xs text-brand-content-muted mb-2">
                  <span>{slider.left}</span>
                  <span>{slider.right}</span>
                </div>
                <div className="relative h-1 rounded bg-brand-line mb-2">
                  <span
                    className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-accent"
                    style={{ left: `${slider.pos}%` }}
                  />
                </div>
                <p className="text-xs text-brand-content-muted">{slider.note}</p>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-x-8 gap-y-2 font-brand-body text-xs mb-6">
            <div>
              <span className="text-brand-content-muted uppercase tracking-wide">Lean on: </span>
              <span className="text-brand-content">{canon.voice.leanOnWords.join(", ")}</span>
            </div>
            <div>
              <span className="text-brand-accent uppercase tracking-wide">Never: </span>
              <span className="text-brand-content">{canon.voice.neverWords.join(", ")}</span>
            </div>
          </div>

          {canon.voice.rewrites?.length > 0 && (
            <>
              <p className={`${KICKER} mb-3`}>In practice</p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {canon.voice.rewrites.map((rw, i) => (
                  <div key={i} className="rounded-lg border border-brand-line p-3 font-brand-body">
                    <p className="text-2xs uppercase tracking-wide text-brand-content-muted mb-1">
                      {rw.context}
                    </p>
                    <p className="text-sm text-brand-content">
                      <span className="text-brand-primary">✓ </span>
                      {rw.on}
                    </p>
                    <p className="text-xs text-brand-content-muted mt-1">
                      <span className="text-brand-accent">✕ </span>
                      {rw.off}
                    </p>
                  </div>
                ))}
              </div>
            </>
          )}
        </GuideSection>

        {/* Naming */}
        <GuideSection id="naming" num={num.get("naming")} title="Naming" lead={canon.naming.pattern}>
          <p className={`${KICKER} mb-3`}>Criteria</p>
          <ol className="list-decimal list-outside pl-5 marker:text-brand-accent font-brand-body text-sm text-brand-content space-y-1.5 mb-6">
            {canon.naming.criteria.map((c, i) => (
              <li key={i} className="pl-1">
                {c}
              </li>
            ))}
          </ol>
          {canon.naming.passingExamples && canon.naming.passingExamples.length > 0 && (
            <>
              <p className={`${KICKER} mb-3`}>Passing examples</p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {canon.naming.passingExamples.map((ex) => (
                  <div key={ex.name} className="rounded-lg border border-brand-line p-3">
                    <p className="font-brand-display text-brand-high-contrast">{ex.name}</p>
                    <p className="font-brand-body text-xs text-brand-content-muted mt-1">{ex.why}</p>
                  </div>
                ))}
              </div>
            </>
          )}
        </GuideSection>

        {/* Illustration law */}
        {canon.illustrationLaw?.rules?.length > 0 && (
          <GuideSection
            id="illustration"
            num={num.get("illustration")}
            title="Illustration"
            lead={canon.illustrationLaw.narrative}
          >
            <ul className="grid gap-x-10 gap-y-2 sm:grid-cols-2 font-brand-body text-sm text-brand-content">
              {canon.illustrationLaw.rules.map((r, i) => (
                <li key={i} className="flex gap-2.5 leading-relaxed">
                  <span className="text-brand-accent shrink-0" aria-hidden="true">
                    —
                  </span>
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </GuideSection>
        )}

        {/* Tap list — approved labels */}
        {labels.length > 0 && (
          <GuideSection id="taplist" num={num.get("taplist")} title="Tap list">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {labels.map((label) => (
                <div key={label.id} className="rounded-lg border border-brand-line p-4">
                  <p className="font-brand-display text-lg text-brand-high-contrast">{label.name}</p>
                  {label.subtitle && (
                    <p className="font-brand-body text-sm text-brand-content mt-0.5">{label.subtitle}</p>
                  )}
                  {label.motif_family && (
                    <p className="font-brand-body text-2xs uppercase tracking-wide text-brand-content-muted mt-2">
                      {label.motif_family}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </GuideSection>
        )}

        {/* Precedence + hard rules */}
        <GuideSection id="rules" num={num.get("rules")} title="Precedence & rules">
          <div className="flex flex-col gap-10">
            {/* Precedence — an ordered hierarchy: when directives conflict, the
                earlier item wins. Rendered as a ranked list, not a bullet list. */}
            <div>
              <p className={`${KICKER} mb-1`}>Precedence</p>
              <p className="font-brand-body text-sm text-brand-content-muted mb-4">
                When two directives conflict, resolve in this order — the earlier item wins.
              </p>
              <ol className="flex flex-col divide-y divide-brand-line border-y border-brand-line">
                {canon.precedence.map((p, i) => (
                  <li key={i} className="flex gap-4 py-3">
                    <span className="font-brand-body text-sm tabular-nums text-brand-accent shrink-0 leading-relaxed">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="font-brand-body text-sm text-brand-content leading-relaxed">
                      {p}
                    </span>
                  </li>
                ))}
              </ol>
            </div>

            {/* Hard rules — the non-negotiable quick reference. Two-column,
                true hanging indents so wrapped lines stay clear of the marker. */}
            <div>
              <p className={`${KICKER} mb-1`}>Hard rules</p>
              <p className="font-brand-body text-sm text-brand-content-muted mb-4">
                Non-negotiables — each one is a fail-the-review line.
              </p>
              <ul className="grid gap-x-12 gap-y-3 lg:grid-cols-2 font-brand-body text-sm text-brand-content">
                {(canon.hardRules ?? []).map((r, i) => (
                  <li key={i} className="flex gap-2.5 leading-relaxed">
                    <span className="text-brand-accent shrink-0" aria-hidden="true">
                      •
                    </span>
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </GuideSection>
      </div>
    </div>
  );
}
