import type { BrandCanon } from "./canon.types";
import { GUIDE_SECTIONS, resolveGuideIntro, type GuideSectionKey } from "./guideIntros";
import { normalizeRules, splitByPolarity, type GuideRule } from "./guideRules";
import { sourceOf } from "./fontRegistry";

/**
 * Compiles the whole brand canon into Markdown, section by section.
 *
 * This is the Agent Rules subtab, and the single brief an agent is given. It is
 * compiled FROM the canon rather than written alongside it, so it cannot drift
 * from what the other subtabs show — the failure mode of every hand-maintained
 * brand summary.
 *
 * Sections mirror the guide's subtabs one-to-one so a reader can map a heading
 * back to the tab that owns it, plus one `technical` section for direction that
 * applies only to agents.
 */

export type BrandMarkdownKey = GuideSectionKey | "technical";

export interface BrandMarkdownSection {
  key: BrandMarkdownKey;
  heading: string;
  markdown: string;
}

const HEADINGS: Record<BrandMarkdownKey, string> = {
  ethos: "Ethos",
  voice: "Voice",
  visual: "Visual Identity",
  color: "Color",
  type: "Type",
  marks: "Marks",
  agent: "Precedence & hard rules",
  technical: "Technical rules for agents",
};

/** `- ` bullets, or nothing at all for an empty list. */
function bullets(items: string[]): string[] {
  return items.filter((i) => i.trim().length > 0).map((i) => `- ${i}`);
}

/** A rule as one line, with its polarity spelled out. */
function ruleLine(rule: GuideRule): string {
  const body = rule.detail ? `${rule.title} — ${rule.detail}` : rule.title;
  return `- ${rule.polarity === "dont" ? "NEVER" : "ALWAYS"}: ${body}`;
}

function rulesBlock(rules: GuideRule[]): string[] {
  const { dos, donts } = splitByPolarity(rules);
  return [...dos, ...donts].map(ruleLine);
}

/** Intro prose, kept as-is — it is already the human-readable summary. */
function intro(canon: BrandCanon, section: GuideSectionKey): string[] {
  const text = resolveGuideIntro(canon, section).trim();
  return text ? [text, ""] : [];
}

function ethos(canon: BrandCanon): string[] {
  const lines = intro(canon, "ethos");
  for (const v of canon.values ?? []) {
    lines.push(`### ${v.n}. ${v.title}`, `- Means: ${v.means}`, `- Costs: ${v.cost}`, "");
  }
  return lines;
}

function voice(canon: BrandCanon): string[] {
  const lines = intro(canon, "voice");
  const { sliders, leanOnWords, neverWords, rewrites } = canon.voice;

  if (sliders.length > 0) {
    lines.push("### Calibration");
    for (const s of sliders) {
      lines.push(`- ${s.left} ↔ ${s.right}: ${s.pos}/100 toward ${s.right}. ${s.note}`);
    }
    lines.push("");
  }

  if (leanOnWords.length > 0 || neverWords.length > 0) {
    lines.push("### Vocabulary");
    if (leanOnWords.length > 0) lines.push(`- Lean on: ${leanOnWords.join(", ")}`);
    // Stated as an absolute: one of these is enough to make copy off-voice.
    if (neverWords.length > 0) lines.push(`- NEVER use: ${neverWords.join(", ")}`);
    lines.push("");
  }

  if (rewrites.length > 0) {
    lines.push("### In practice");
    for (const r of rewrites) {
      lines.push(`- ${r.context}`, `  - On-voice: ${r.on}`, `  - Off-voice: ${r.off}`);
    }
    lines.push("");
  }

  return lines;
}

function visual(canon: BrandCanon): string[] {
  const lines = intro(canon, "visual");
  lines.push(...rulesBlock(normalizeRules(canon.illustrationLaw?.rules, "do")), "");
  return lines;
}

function color(canon: BrandCanon): string[] {
  const lines = intro(canon, "color");

  lines.push("### Palette");
  for (const c of canon.palette) {
    const codes = [c.hex.toUpperCase(), c.cmyk && `CMYK ${c.cmyk}`, c.pms && `PMS ${c.pms}`]
      .filter(Boolean)
      .join(" · ");
    lines.push(`- ${c.name} (\`${c.key}\`): ${codes}${c.role ? ` — ${c.role}` : ""}`);
  }
  lines.push("");

  // The role map is what an agent actually binds to, so it is stated as
  // key→role rather than left implicit in the palette list.
  lines.push("### Roles", "Bind to these, never to a color name.");
  for (const [role, value] of Object.entries(canon.roleMap.light)) {
    const dark = canon.roleMap.dark?.[role as keyof typeof canon.roleMap.dark];
    lines.push(`- ${role}: light \`${value}\`${dark ? `, dark \`${dark}\`` : ""}`);
  }
  lines.push("");

  if (canon.usageRatios.length > 0) {
    lines.push("### Usage ratios");
    for (const r of canon.usageRatios) {
      lines.push(`- ${r.role}: ${r.pct}%${r.note ? ` — ${r.note}` : ""}`);
    }
    lines.push("");
  }

  const forbidden = normalizeRules(canon.colorForbidden, "dont");
  if (forbidden.length > 0) {
    lines.push("### Forbidden", ...rulesBlock(forbidden), "");
  }

  return lines;
}

function type(canon: BrandCanon): string[] {
  const lines = intro(canon, "type");

  lines.push("### Faces");
  for (const f of canon.fonts) {
    lines.push(
      `- ${f.role}: ${f.family} (${sourceOf(f)}), weights ${f.weights.join(", ")}${
        f.note ? ` — ${f.note}` : ""
      }`,
    );
  }
  lines.push("");

  const useCases = canon.typeUseCases ?? [];
  if (useCases.length > 0) {
    lines.push("### Use cases");
    for (const u of useCases) {
      lines.push(
        `- ${u.medium} · ${u.element}: ${u.fontRole} ${u.weight} at ${u.size}${
          u.tracking ? `, tracking ${u.tracking}` : ""
        }${u.notes ? ` — ${u.notes}` : ""}`,
      );
    }
    lines.push("");
  }

  return lines;
}

function marks(canon: BrandCanon): string[] {
  const lines = intro(canon, "marks");

  for (const mark of canon.marks ?? []) {
    lines.push(`### ${mark.title || mark.kind}`);
    if (mark.status) lines.push(`Status: ${mark.status}`);

    const usage = rulesBlock(normalizeRules(mark.usage, "do"));
    if (usage.length > 0) lines.push(...usage);

    for (const v of mark.variants) {
      const specs = v.specs.map((s) => `${s.key} ${s.value}`).join(", ");
      lines.push(`- ${v.code}${v.cut ? ` (${v.cut})` : ""}${specs ? `: ${specs}` : ""}`);
    }
    if (mark.clearspace?.length) lines.push(...bullets(mark.clearspace));
    lines.push("");
  }

  return lines;
}

function agent(canon: BrandCanon): string[] {
  const lines = intro(canon, "agent");

  if (canon.neverList?.length) {
    lines.push("### The Never List", ...bullets(canon.neverList), "");
  }

  if (canon.precedence?.length) {
    lines.push("### Precedence", "When two directives conflict, the earlier wins.");
    canon.precedence.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
    lines.push("");
  }

  if (canon.hardRules?.length) {
    lines.push("### Hard rules", "Each one is a fail-the-review line.", ...bullets(canon.hardRules), "");
  }

  return lines;
}

function technical(canon: BrandCanon): string[] {
  const rules = canon.agentTechnical ?? [];
  if (rules.length === 0) return [];
  return [...bullets(rules), ""];
}

const BUILDERS: Record<BrandMarkdownKey, (canon: BrandCanon) => string[]> = {
  ethos,
  voice,
  visual,
  color,
  type,
  marks,
  agent,
  technical,
};

export function compileBrandMarkdown(canon: BrandCanon): {
  sections: BrandMarkdownSection[];
  full: string;
} {
  const order: BrandMarkdownKey[] = [...GUIDE_SECTIONS, "technical"];

  const sections = order
    .map((key) => {
      const body = BUILDERS[key](canon).join("\n").trim();
      return { key, heading: HEADINGS[key], markdown: `## ${HEADINGS[key]}\n\n${body}` };
    })
    // A section with no content beyond its heading is omitted rather than
    // shipped empty — an agent reading a bare heading learns nothing.
    .filter((s) => s.markdown.trim() !== `## ${s.heading}`);

  // Joined with a blank line between blocks, so the blocks themselves carry no
  // trailing padding of their own.
  const full = [
    `# ${canon.brandName} — Brand Guide`,
    "Compiled from the brand canon. Do not edit by hand; edit the Brand Guide.",
    ...sections.map((s) => s.markdown),
    "When uncertain: produce nothing and escalate to the founder.",
  ].join("\n\n");

  return { sections, full };
}
