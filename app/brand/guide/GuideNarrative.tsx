import type { BrandCanon } from "@/lib/brand/canon.types";
import type { BrandLabel } from "@/lib/brand/labels";
import GuideSection, { KICKER } from "./GuideSection";
import GuideToc, { type TocEntry } from "./GuideToc";

/**
 * The Guide tab's view: the narrative + rules sections (Color and Typography
 * live in their own tabs now). A thesis hero leads with the mission line; each
 * section carries a reference number + display title + hairline rule; a sticky
 * Contents rail (xl) aids navigation.
 */
export default function GuideNarrative({
  canon,
  wordmarkUrl,
  labels,
}: {
  canon: BrandCanon;
  wordmarkUrl: string | null;
  labels: BrandLabel[];
}) {
  // Single ordered source for both the numbering and the Contents rail, so a
  // conditionally-absent section never leaves a gap in the sequence.
  const sectionMeta: { id: string; title: string; present: boolean }[] = [
    { id: "ethos", title: "Ethos", present: !!canon.missionNarrative },
    { id: "values", title: "Values & costs", present: (canon.values?.length ?? 0) > 0 },
    { id: "never", title: "The Never List", present: (canon.neverList?.length ?? 0) > 0 },
    { id: "voice", title: "Voice", present: true },
    { id: "naming", title: "Naming", present: true },
    { id: "chop", title: "The chop", present: (canon.chop?.specs?.length ?? 0) > 0 },
    { id: "chassis", title: "Label chassis", present: (canon.labelChassis?.elements?.length ?? 0) > 0 },
    { id: "illustration", title: "Illustration", present: (canon.illustrationLaw?.rules?.length ?? 0) > 0 },
    { id: "taplist", title: "Tap list", present: labels.length > 0 },
    { id: "rules", title: "Precedence & rules", present: true },
  ];
  const present = sectionMeta.filter((s) => s.present);
  const num = new Map(present.map((s, i) => [s.id, String(i + 1).padStart(2, "0")]));
  const toc: TocEntry[] = present.map((s) => ({ id: s.id, title: s.title }));

  return (
    <div>
      {/* Hero — the mission line is the thesis */}
      <header className="mb-14 sm:mb-20 border-b border-brand-line pb-10">
        <div className="flex items-center gap-3 mb-6">
          {wordmarkUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- approved brand asset from Storage, not a static import
            <img src={wordmarkUrl} alt={canon.brandName} className="h-8 w-auto" />
          ) : (
            <span className="font-brand-wordmark text-2xl tracking-wide text-brand-primary">
              {canon.brandName}
            </span>
          )}
          <span className="font-brand-body text-2xs uppercase tracking-wide text-brand-content-muted">
            Brand guide · v{canon.version}
          </span>
        </div>
        <p className="font-brand-display text-3xl sm:text-5xl leading-tight text-brand-high-contrast max-w-4xl">
          {canon.mission}
        </p>
      </header>

      <div className="grid gap-x-12 xl:grid-cols-[15rem_minmax(0,1fr)]">
        <GuideToc entries={toc} />

        <div className="min-w-0 flex flex-col gap-16 sm:gap-20">
          {/* Ethos */}
          {canon.missionNarrative && (
            <GuideSection id="ethos" num={num.get("ethos")} title="Ethos">
              <p className="font-brand-body text-brand-content leading-relaxed max-w-3xl">
                {canon.missionNarrative}
              </p>
            </GuideSection>
          )}

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
              <ul className="list-disc list-inside font-brand-body text-sm text-brand-content space-y-1 max-w-3xl">
                {canon.neverList.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </GuideSection>
          )}

          {/* Voice */}
          <GuideSection id="voice" num={num.get("voice")} title="Voice" lead={canon.voice.summary}>
            {canon.voice.personality && (
              <p className="font-brand-body text-sm text-brand-content-muted leading-relaxed max-w-3xl mb-6">
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
            <ol className="list-decimal list-inside font-brand-body text-sm text-brand-content space-y-1 mb-6 max-w-3xl">
              {canon.naming.criteria.map((c, i) => (
                <li key={i}>{c}</li>
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

          {/* The chop */}
          {canon.chop?.specs?.length > 0 && (
            <GuideSection id="chop" num={num.get("chop")} title="The chop" lead={canon.chop.narrative}>
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3 font-brand-body text-sm">
                {canon.chop.specs.map((s, i) => (
                  <div key={i}>
                    <dt className="text-brand-content-muted text-xs uppercase tracking-wide">{s.key}</dt>
                    <dd className="text-brand-content">{s.value}</dd>
                  </div>
                ))}
              </dl>
            </GuideSection>
          )}

          {/* Label chassis */}
          {canon.labelChassis?.elements?.length > 0 && (
            <GuideSection
              id="chassis"
              num={num.get("chassis")}
              title="Label chassis"
              lead={canon.labelChassis.narrative}
            >
              <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {canon.labelChassis.elements.map((el) => (
                  <li key={el.n} className="rounded-lg border border-brand-line p-3 font-brand-body">
                    <p className="text-sm text-brand-high-contrast">
                      {el.n} · {el.title}
                    </p>
                    <p className="text-xs text-brand-content-muted mt-0.5">{el.desc}</p>
                  </li>
                ))}
              </ol>
            </GuideSection>
          )}

          {/* Illustration law */}
          {canon.illustrationLaw?.rules?.length > 0 && (
            <GuideSection
              id="illustration"
              num={num.get("illustration")}
              title="Illustration"
              lead={canon.illustrationLaw.narrative}
            >
              <ul className="list-disc list-inside font-brand-body text-sm text-brand-content space-y-1 max-w-3xl">
                {canon.illustrationLaw.rules.map((r, i) => (
                  <li key={i}>{r}</li>
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
            <div className="grid gap-8 sm:grid-cols-2">
              <div>
                <p className={`${KICKER} mb-3`}>Precedence</p>
                <ol className="list-decimal list-inside font-brand-body text-sm text-brand-content space-y-1">
                  {canon.precedence.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ol>
              </div>
              <div>
                <p className={`${KICKER} mb-3`}>Hard rules</p>
                <ul className="list-disc list-inside font-brand-body text-sm text-brand-content space-y-1">
                  {(canon.hardRules ?? []).map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            </div>
          </GuideSection>
        </div>
      </div>
    </div>
  );
}
