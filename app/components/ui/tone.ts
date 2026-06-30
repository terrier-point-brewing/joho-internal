// Semantic tones — the single source for status/accent coloring across Badge, Banner,
// and any status pill. Maps a tone to token-backed utility classes. See docs/UI_STANDARD.md.

export type Tone = "neutral" | "accent" | "success" | "danger" | "info";

/** Soft filled treatment (badges, pills, banners): tinted bg + colored text + border. */
export const TONE_SOFT: Record<Tone, string> = {
  neutral: "bg-surface-mid text-secondary border-line-strong",
  accent: "bg-accent-muted/30 text-accent-soft border-accent-border",
  success: "bg-success-surface/40 text-success border-success-border",
  danger: "bg-danger-surface/40 text-danger border-danger-border",
  info: "bg-info-surface/40 text-info border-info-border",
};

/** Text-only treatment (inline status text). */
export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-secondary",
  accent: "text-accent",
  success: "text-success",
  danger: "text-danger",
  info: "text-info",
};
