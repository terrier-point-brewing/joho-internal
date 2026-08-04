import type { BrandCanon } from "@/lib/brand/canon.types";
import SubHead from "./blocks/SubHead";
import SpecCard from "./blocks/SpecCard";
import LabelDiagram from "./blocks/LabelDiagram";

/**
 * Release Design view: how a new release is designed, with the label as the
 * frame. Both halves lived apart — naming at the tail of Voice, the chassis at
 * the tail of Visual Identity — but they were never two subjects: the card
 * names the release, the chassis is what it's poured into.
 *
 * The tab runs in the order a release is made ("story before ship"): naming
 * first — the five gates, the template card, the releases that clear them —
 * then the chassis, drawn as an annotated label rather than only listed as
 * spec cards, so the one fixed frame can be seen and not just read about.
 */
export default function ReleaseView({
  canon,
  wordmarkUrl,
}: {
  canon: BrandCanon;
  /** Approved wordmark artwork for the chassis diagram's top band. */
  wordmarkUrl?: string | null;
}) {
  const naming = canon.naming;
  // The narrative is the template for a release card, so it renders as one:
  // same component, same labels, same order as the examples below it. A field
  // with no instruction written yet drops out rather than showing a bare label.
  const narrative = naming?.narrative;
  const templateRows = [
    { label: "Name", value: narrative?.name },
    { label: "Story line", value: narrative?.story },
    { label: "Menu description", value: narrative?.menuDescription },
    { label: "Why it passes", value: narrative?.why },
  ].flatMap((row) => (row.value ? [{ label: row.label, value: row.value }] : []));

  const chassis = canon.labelChassis;
  const elements = chassis?.elements ?? [];

  return (
    <>
      {naming && (
        <section className="mb-8">
          <SubHead
            title="Naming"
            description="The five gates a name must clear, the card each release is written as, and the releases that pass."
          />
          {naming.criteria?.length > 0 && (
            <ol className="flex flex-col gap-1.5 mb-6">
              {naming.criteria.map((criterion, i) => (
                <li key={i} className="font-brand-body text-sm text-brand-content flex gap-2">
                  <span className="text-brand-content-muted tabular-nums shrink-0">{i + 1}.</span>
                  <span>{criterion}</span>
                </li>
              ))}
            </ol>
          )}
          {templateRows.length > 0 && (
            <>
              {narrative?.intro && (
                <p className="font-brand-body text-sm text-brand-content leading-relaxed mb-3">
                  {narrative.intro}
                </p>
              )}
              <SpecCard
                variant="template"
                tag="Release card"
                title="Writing a release card"
                rows={templateRows}
                footer={narrative?.footer}
              />
            </>
          )}
          {naming.passingExamples?.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 mt-4">
              {naming.passingExamples.map((example, i) => (
                <SpecCard
                  key={i}
                  title={[example.storyTitle, example.beerStyle].filter(Boolean).join(" — ")}
                  rows={[
                    // Story and menu line are optional in the canon — a card
                    // that has neither still reads as it always did.
                    ...(example.story ? [{ label: "Story line", value: example.story }] : []),
                    ...(example.menuDescription
                      ? [{ label: "Menu description", value: example.menuDescription }]
                      : []),
                    { label: "Why it passes", value: example.why },
                  ]}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {(chassis?.narrative || elements.length > 0) && (
        <section>
          <SubHead
            title="The label chassis"
            description="The fixed frame every release is poured into. The illustration roams; the chassis is home."
          />
          {chassis?.narrative && (
            <p className="font-brand-body text-sm text-brand-content leading-relaxed mb-4">
              {chassis.narrative}
            </p>
          )}
          {elements.length > 0 && (
            <div className="mb-4">
              <LabelDiagram elements={elements} wordmarkUrl={wordmarkUrl} />
            </div>
          )}
          {elements.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Storage order pairs elements to diagram zones by position (see
                  LabelDiagram) and can't be reordered; `n` carries the reading
                  order instead, so the cards are sorted by it here. */}
              {[...elements]
                .sort((a, b) => Number(a.n) - Number(b.n))
                .map((element) => (
                  <SpecCard
                    key={element.n}
                    eyebrow={element.n}
                    title={element.title}
                    rows={[{ label: "Rule", value: element.desc }]}
                  />
                ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}
