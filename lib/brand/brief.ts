import type { BrandCanon } from "./canon.types";

export function compileAgentBrief(canon: BrandCanon): string {
  const lines: string[] = [];

  lines.push("MISSION");
  lines.push(canon.mission);
  lines.push("");

  lines.push("VOICE");
  lines.push(canon.voice.summary);
  lines.push(`Lean on: ${canon.voice.leanOnWords.join(", ")}`);
  lines.push(`Never use: ${canon.voice.neverWords.join(", ")}`);
  lines.push("");

  lines.push("COLOR ROLES & USAGE RATIOS");
  for (const ratio of canon.usageRatios) {
    const note = ratio.note ? ` — ${ratio.note}` : "";
    lines.push(`${ratio.role}: ${ratio.pct}%${note}`);
  }
  lines.push("Seal Red ≤5% of any composition.");
  lines.push("");

  lines.push("NAMING");
  lines.push(`Pattern: ${canon.naming.pattern}`);
  for (const criterion of canon.naming.criteria) {
    lines.push(`- ${criterion}`);
  }
  lines.push("");

  lines.push("PRECEDENCE");
  canon.precedence.forEach((step, i) => {
    lines.push(`${i + 1}. ${step}`);
  });
  lines.push("");

  lines.push("AGENT RULES");
  for (const rule of canon.agentRules) {
    lines.push(`- ${rule}`);
  }
  lines.push("");

  lines.push("When uncertain: produce nothing; escalate to founder");

  return lines.join("\n");
}
