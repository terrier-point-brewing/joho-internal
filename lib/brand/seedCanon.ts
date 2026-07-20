import type { BrandCanon } from "./canon.types";

export const seedCanon: BrandCanon = {
  brandName: "Joho",
  version: "1.0",
  mission:
    "Joho brews sincere, unpretentious beer for people who want a companion at the end of the day, not a lecture on hops.",
  palette: [
    { key: "paper", name: "Paper", hex: "#f5f0e6" },
    { key: "indigo", name: "Indigo", hex: "#26355d" },
    { key: "seal-red", name: "Seal Red", hex: "#ad1a2d" },
    { key: "camphor", name: "Camphor Tan", hex: "#b3a585" },
    { key: "paper-2", name: "Paper 2", hex: "#efe8da" },
    { key: "paper-3", name: "Paper 3", hex: "#ded5c1" },
    { key: "content", name: "Content Ink", hex: "#3a4256" },
    { key: "content-muted", name: "Content Ink Muted", hex: "#6b6f7d" },
  ],
  roleMap: {
    light: {
      canvas: "paper",
      surface: "paper-2",
      "surface-raised": "paper-3",
      primary: "indigo",
      "on-primary": "paper",
      secondary: "camphor",
      accent: "seal-red",
      "on-accent": "paper",
      "high-contrast": "indigo",
      content: "content",
      "content-muted": "content-muted",
      line: "paper-3",
      "line-strong": "camphor",
    },
    dark: {},
  },
  usageRatios: [
    { role: "canvas", pct: 60, note: "Paper dominates every composition." },
    { role: "primary", pct: 30, note: "Indigo carries structure and identity." },
    { role: "accent", pct: 10, note: "Seal Red ≤5% of any composition." },
  ],
  fonts: [
    { role: "display", family: "Marcellus", cssStack: '"Marcellus", serif', weights: [400] },
    { role: "body", family: "Lato", cssStack: '"Lato", sans-serif', weights: [400, 700] },
    {
      role: "wordmark",
      family: "Jost",
      cssStack: '"Jost", sans-serif',
      weights: [500],
      note: "interim placeholder — pending §11",
    },
    { role: "script", family: "Noto Serif SC", cssStack: '"Noto Serif SC", serif', weights: [400] },
  ],
  voice: {
    summary:
      "A companion, not a teacher. Sincere to the bone… quietly funny, dry.",
    sliders: [
      { label: "Tone", left: "Reverent", right: "Playful", note: "Leans playful, never silly." },
      { label: "Formality", left: "Formal", right: "Casual", note: "Leans casual, never sloppy." },
    ],
    neverWords: ["crushable", "sesh", "epic", "elevated"],
    leanOnWords: ["honest", "sincere", "quiet", "companion"],
  },
  naming: {
    pattern: "Story Title — Plain Style Subtitle",
    criteria: [
      "Grounded in a real story, place, or person — not a generic beer cliché",
      "Readable and speakable on first pass, no forced puns",
      "Plain style subtitle names the style without jargon",
      "Never leans on the neverWords list",
      "Passes the 'would Joho say this out loud' test",
    ],
    passingExamples: [
      { name: "Holly Springs — Plain Pilsner", why: "Grounded in place, plain subtitle, no jargon" },
    ],
  },
  precedence: [
    "Specification over Narrative",
    "Full sections over the agent quick-reference (§8)",
    "When uncertain: produce nothing; escalate to founder",
  ],
  agentRules: [
    "Consumers bind to semantic role tokens only — never a brand or color name.",
    "Dark mode auto-derives from light; roleMap.dark holds sparse overrides only.",
    "Seal Red never exceeds 5% of any single composition.",
    "Never use a neverWords term in copy.",
    "When uncertain: produce nothing; escalate to founder.",
  ],
};
