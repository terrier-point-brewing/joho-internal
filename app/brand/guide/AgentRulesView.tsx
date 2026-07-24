import type { BrandCanon } from "@/lib/brand/canon.types";
import GuideSection, { KICKER } from "./GuideSection";

/**
 * Agent Rules view: the machine-facing rules of the brand — the Never List, the
 * precedence order, and the hard rules. This subtab is largely reference for
 * agents rather than a human read, and is the eventual home for the full
 * Markdown Brand Guide instructions. Single unnumbered section, matching the
 * Color/Type tab layout.
 */
export default function AgentRulesView({ canon }: { canon: BrandCanon }) {
  return (
    <GuideSection
      title="Agent Rules"
      lead="The machine-facing brand rules — reference for agents building on the brand."
    >
      <div className="flex flex-col gap-10">
        {/* The Never List */}
        {canon.neverList?.length > 0 && (
          <div>
            <p className={`${KICKER} mb-3`}>The Never List</p>
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
          </div>
        )}

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
                <span className="font-brand-body text-sm text-brand-content leading-relaxed">{p}</span>
              </li>
            ))}
          </ol>
        </div>

        {/* Hard rules — the non-negotiable quick reference. Two-column, true
            hanging indents so wrapped lines stay clear of the marker. */}
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
  );
}
