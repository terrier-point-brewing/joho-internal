import type { BrandCanon, FontRole } from "@/lib/brand/canon.types";
import { resolveGuideIntro } from "@/lib/brand/guideIntros";
import GuideSection from "./GuideSection";

const FONT_CLASS: Record<FontRole, string> = {
  display: "font-brand-display",
  body: "font-brand-body",
  wordmark: "font-brand-wordmark",
  script: "font-brand-script",
};

/** Typography view: one specimen per font role. */
export default function TypeView({ canon }: { canon: BrandCanon }) {
  return (
    <GuideSection intro={resolveGuideIntro(canon, "type")}>
      <div className="flex flex-col gap-6">
        {canon.fonts.map((font) => (
          <div key={font.role} className="border-b border-brand-line pb-6 last:border-0 last:pb-0">
            <p className="font-brand-body text-xs text-brand-content-muted mb-2">
              {font.role} · {font.family} · weights {font.weights.join(", ")}
              {font.note ? ` · ${font.note}` : ""}
            </p>
            <p className={`${FONT_CLASS[font.role]} text-3xl sm:text-4xl text-brand-high-contrast`}>
              {canon.brandName} — The quick brown fox
            </p>
          </div>
        ))}
      </div>
    </GuideSection>
  );
}
