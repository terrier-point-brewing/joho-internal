import type { BrandCanon } from "@/lib/brand/canon.types";
import { resolveGuideIntro } from "@/lib/brand/guideIntros";
import { compileBrandMarkdown } from "@/lib/brand/markdown";
import GuideSection from "./GuideSection";
import SubHead from "./blocks/SubHead";
import MarkdownBlock from "./blocks/MarkdownBlock";

/** A filename-safe slug for a section download. */
function slug(heading: string): string {
  return heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Agent Rules view: the whole brand canon as Markdown, copyable whole or by
 * section.
 *
 * Everything here is COMPILED from the other subtabs rather than written
 * alongside them, so it cannot drift from what the guide shows — the failure
 * mode of every hand-maintained brand summary. The only content unique to this
 * tab is the technical section, which holds direction that applies to agents
 * and to nothing a human reads elsewhere.
 *
 * The Markdown is shown as source, not rendered. The audience is an agent and
 * the thing being copied is the text itself; formatting it would hide the exact
 * string that ends up in a prompt.
 */
export default function AgentRulesView({ canon }: { canon: BrandCanon }) {
  const { sections, full } = compileBrandMarkdown(canon);

  return (
    <GuideSection intro={resolveGuideIntro(canon, "agent")}>
      <section className="mb-8">
        <SubHead
          title="Full brief"
          description="Everything below, as one document. This is what an agent should be given."
        />
        <MarkdownBlock
          markdown={full}
          label={`${canon.brandName} — Brand Guide`}
          filename={`${slug(canon.brandName)}-brand-guide.md`}
        />
      </section>

      <section>
        <SubHead
          title="By section"
          description="The same content split by subtab, for when only one part is relevant."
        />
        <div className="flex flex-col gap-3">
          {sections.map((section) => (
            <MarkdownBlock
              key={section.key}
              markdown={section.markdown}
              label={section.heading}
              filename={`${slug(canon.brandName)}-${slug(section.heading)}.md`}
            />
          ))}
        </div>
      </section>
    </GuideSection>
  );
}
