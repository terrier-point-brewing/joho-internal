import type { BrandCanon } from "./canon.types";
import { resolveGuideIntro, splitParagraphs } from "./guideIntros";

// Compiles the canon into a precedence-ordered plain-text brief for AI
// features (Phase 4). Carries both the Narrative (mission, values, voice) and
// the Specification (color, naming, illustration, hard rules) so generated
// artifacts stay on-brand and on-voice.
export function compileAgentBrief(canon: BrandCanon): string {
  const lines: string[] = [];

  // The narrative sections are read through the guide's intro resolver, so
  // agents are told exactly what the Ethos/Voice/Visual Identity subtabs show —
  // an edited introduction can't leave the brief behind.
  lines.push("ETHOS");
  lines.push(...splitParagraphs(resolveGuideIntro(canon, "ethos")));
  lines.push("");

  lines.push("VALUES");
  for (const v of canon.values) {
    lines.push(`- ${v.title}: ${v.means}`);
  }
  lines.push("");

  lines.push("NEVER");
  for (const n of canon.neverList) {
    lines.push(`- ${n}`);
  }
  lines.push("");

  lines.push("VOICE");
  lines.push(...splitParagraphs(resolveGuideIntro(canon, "voice")));
  lines.push(`Lean on: ${canon.voice.leanOnWords.join(", ")}`);
  lines.push(`Never use: ${canon.voice.neverWords.join(", ")}`);
  for (const r of canon.voice.rewrites) {
    lines.push(`${r.context} — on-voice: ${r.on}`);
    lines.push(`${r.context} — off-voice: ${r.off}`);
  }
  lines.push("");

  lines.push("COLOR ROLES & USAGE RATIOS");
  for (const ratio of canon.usageRatios) {
    const note = ratio.note ? ` — ${ratio.note}` : "";
    lines.push(`${ratio.role}: ${ratio.pct}%${note}`);
  }
  lines.push("Seal Red ≤5% of any composition.");
  for (const f of canon.colorForbidden) {
    lines.push(`Forbidden: ${f}`);
  }
  lines.push("");

  lines.push("NAMING");
  lines.push(`Pattern: ${canon.naming.pattern}`);
  for (const criterion of canon.naming.criteria) {
    lines.push(`- ${criterion}`);
  }
  lines.push("");

  lines.push("ILLUSTRATION LAW");
  lines.push(...splitParagraphs(resolveGuideIntro(canon, "visual")));
  for (const rule of canon.illustrationLaw.rules) {
    lines.push(`- ${rule}`);
  }
  lines.push("");

  lines.push("HARD RULES");
  for (const rule of canon.hardRules) {
    lines.push(`- ${rule}`);
  }
  lines.push("");

  lines.push("PRECEDENCE");
  canon.precedence.forEach((step, i) => {
    lines.push(`${i + 1}. ${step}`);
  });
  lines.push("");

  lines.push("When uncertain: produce nothing; escalate to founder");

  return lines.join("\n");
}
