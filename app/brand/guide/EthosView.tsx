import type { ReactNode } from "react";
import type { BrandCanon } from "@/lib/brand/canon.types";
import { resolveGuideIntro } from "@/lib/brand/guideIntros";
import GuideSection from "./GuideSection";
import SpecCard from "./blocks/SpecCard";

/**
 * Ethos view: the introduction, then the values.
 *
 * Each value is one card with two equally-labelled halves — what it means, and
 * what it costs. They used to be asymmetric: only the cost carried a label, so
 * the meaning read as unlabelled prose and the pairing wasn't obvious.
 */
export default function EthosView({ canon, topRight }: { canon: BrandCanon; topRight?: ReactNode }) {
  return (
    <GuideSection section="ethos" intro={resolveGuideIntro(canon, "ethos")} topRight={topRight}>
      {canon.values?.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {canon.values.map((v) => (
            <SpecCard
              key={v.id ?? v.n}
              eyebrow={v.n}
              title={v.title}
              rows={[
                { label: "What it means", value: v.means },
                { label: "The cost", value: v.cost, tone: "accent" },
              ]}
            />
          ))}
        </div>
      )}
    </GuideSection>
  );
}
