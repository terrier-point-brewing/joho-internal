import type { BrandCanon } from "@/lib/brand/canon.types";
import SpecCard from "./blocks/SpecCard";

/**
 * Ethos view: the values grid. The introduction card and the admin View/Edit
 * toggle are rendered around this by BrandGuideTabs (see GuideSection there) —
 * this component only owns the content, since the toggle needs client state
 * that isn't available at the point this Server Component renders.
 *
 * Each value is one card with two equally-labelled halves — what it means, and
 * what it costs. They used to be asymmetric: only the cost carried a label, so
 * the meaning read as unlabelled prose and the pairing wasn't obvious.
 */
export default function EthosView({ canon }: { canon: BrandCanon }) {
  return (
    canon.values?.length > 0 && (
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
    )
  );
}
