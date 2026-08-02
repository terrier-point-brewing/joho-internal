import type { BrandCanon } from "@/lib/brand/canon.types";
import { resolveGuideIntro } from "@/lib/brand/guideIntros";
import GuideSection from "./GuideSection";
import SubHead from "./blocks/SubHead";
import SliderRow from "./blocks/SliderRow";
import ChipList from "./blocks/ChipList";
import ComparisonCard from "./blocks/ComparisonCard";

/**
 * Voice view: introduction, then three sections in a deliberate order —
 * calibration (the register), vocabulary (the words that hit it), and in
 * practice (both applied to real copy). Each narrows from principle to example,
 * which is why vocabulary sits in the middle rather than trailing off the end
 * as the inline afterthought it used to be.
 *
 * Naming rendered here through Phase A, but it was always release doctrine
 * rather than register — it now closes the Release Design tab instead, beside
 * the chassis its cards are poured into.
 */
export default function VoiceView({ canon }: { canon: BrandCanon }) {
  const { sliders, leanOnWords, neverWords, rewrites } = canon.voice;
  const hasVocabulary = leanOnWords.length > 0 || neverWords.length > 0;

  return (
    <GuideSection section="voice" intro={resolveGuideIntro(canon, "voice")}>
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
    </GuideSection>
  );
}
