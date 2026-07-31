import type { BrandCanon } from "@/lib/brand/canon.types";
import { resolveGuideIntro } from "@/lib/brand/guideIntros";
import GuideSection from "./GuideSection";
import SubHead from "./blocks/SubHead";
import SliderRow from "./blocks/SliderRow";
import ChipList from "./blocks/ChipList";
import ComparisonCard from "./blocks/ComparisonCard";
import SpecCard from "./blocks/SpecCard";

/**
 * Voice view: introduction, then three sections in a deliberate order —
 * calibration (the register), vocabulary (the words that hit it), and in
 * practice (both applied to real copy). Each narrows from principle to example,
 * which is why vocabulary sits in the middle rather than trailing off the end
 * as the inline afterthought it used to be.
 */
export default function VoiceView({ canon }: { canon: BrandCanon }) {
  const { sliders, leanOnWords, neverWords, rewrites } = canon.voice;
  const hasVocabulary = leanOnWords.length > 0 || neverWords.length > 0;
  // Naming joins this tab in Phase A. It was stored in the canon and rendered
  // nowhere, while the Releases workbench quietly gated every beer name on its
  // five criteria — a checklist whose source no reader could see.
  const naming = canon.naming;

  return (
    <GuideSection intro={resolveGuideIntro(canon, "voice")}>
      {sliders.length > 0 && (
        <section className="mb-8">
          <SubHead
            title="Calibration"
            description="Where the voice sits on each axis. The number is the position toward the right-hand pole."
          />
          <div className="grid gap-3 lg:grid-cols-2">
            {sliders.map((slider, i) => (
              <SliderRow
                key={slider.id ?? i}
                left={slider.left}
                right={slider.right}
                pos={slider.pos}
                note={slider.note}
              />
            ))}
          </div>
        </section>
      )}

      {hasVocabulary && (
        <section className="mb-8">
          <SubHead
            title="Vocabulary"
            description="The words to reach for, and the ones that put a piece of copy off-voice on their own."
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <ChipList label="Lean on" words={leanOnWords} />
            <ChipList label="Never" words={neverWords} tone="accent" />
          </div>
        </section>
      )}

      {rewrites?.length > 0 && (
        <section>
          <SubHead
            title="In practice"
            description="The same message on-voice and off-voice, so the difference is visible rather than described."
          />
          <div className="flex flex-col gap-3">
            {rewrites.map((rw, i) => (
              <ComparisonCard
                key={rw.id ?? i}
                context={rw.context}
                left={{ label: "✓ On-voice", value: rw.on }}
                right={{ label: "✕ Off-voice", value: rw.off }}
              />
            ))}
          </div>
        </section>
      )}

      {naming && (
        <section className="mt-8">
          <SubHead
            title="Naming"
            description="How a release earns its name. Every release is checked against the five criteria in Releases."
          />
          {naming.pattern && (
            <p className="font-brand-display text-lg text-brand-high-contrast mb-2">
              {naming.pattern}
            </p>
          )}
          {naming.narrative && (
            <p className="font-brand-body text-sm text-brand-content leading-relaxed mb-4">
              {naming.narrative}
            </p>
          )}
          {naming.criteria?.length > 0 && (
            <ol className="flex flex-col gap-1.5 mb-4">
              {naming.criteria.map((criterion, i) => (
                <li key={i} className="font-brand-body text-sm text-brand-content flex gap-2">
                  <span className="text-brand-content-muted tabular-nums shrink-0">{i + 1}.</span>
                  <span>{criterion}</span>
                </li>
              ))}
            </ol>
          )}
          {naming.passingExamples?.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {naming.passingExamples.map((example, i) => (
                <SpecCard
                  key={i}
                  title={example.name}
                  rows={[{ label: "Why it passes", value: example.why }]}
                />
              ))}
            </div>
          )}
        </section>
      )}
    </GuideSection>
  );
}
