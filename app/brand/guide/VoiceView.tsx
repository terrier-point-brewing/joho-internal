import type { BrandCanon } from "@/lib/brand/canon.types";
import { resolveGuideIntro } from "@/lib/brand/guideIntros";
import GuideSection, { KICKER } from "./GuideSection";

/**
 * Voice view: the introduction (the voice summary and personality, until an
 * admin edits it), then the calibration sliders, the lean-on / never word rows,
 * and the in-practice rewrites.
 */
export default function VoiceView({ canon }: { canon: BrandCanon }) {
  return (
    <GuideSection intro={resolveGuideIntro(canon, "voice")}>
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
  );
}
