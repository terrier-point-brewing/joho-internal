"use client";

import { useState } from "react";
import type { BrandCanon, RoleName, ResolvedTokens } from "@/lib/brand/canon.types";
import { resolveTokens } from "@/lib/brand/tokens";
import { firstParagraph } from "@/lib/brand/guideIntros";

const ROLE_NAMES: RoleName[] = [
  "canvas",
  "surface",
  "surface-raised",
  "primary",
  "on-primary",
  "secondary",
  "accent",
  "on-accent",
  "high-contrast",
  "content",
  "content-muted",
  "line",
  "line-strong",
];

// Explicit literal classNames (not template-string interpolation) so
// Tailwind's content scanner picks up every bg-brand-<role> utility — same
// pattern as app/brand/guide/page.tsx's ROLE_SWATCHES.
const ROLE_SWATCH_CLASS: Record<RoleName, string> = {
  canvas: "bg-brand-canvas",
  surface: "bg-brand-surface",
  "surface-raised": "bg-brand-surface-raised",
  primary: "bg-brand-primary",
  "on-primary": "bg-brand-on-primary",
  secondary: "bg-brand-secondary",
  accent: "bg-brand-accent",
  "on-accent": "bg-brand-on-accent",
  "high-contrast": "bg-brand-high-contrast",
  content: "bg-brand-content",
  "content-muted": "bg-brand-content-muted",
  line: "bg-brand-line",
  "line-strong": "bg-brand-line-strong",
};

// Pure: role → hex for the chosen mode, keyed as the `--color-brand-<role>`
// custom properties the .brand-surface scope (and every bg-brand-*/text-brand-*
// utility) consumes. Applied as an inline `style` on a wrapper div so it
// overrides those CSS vars ONLY within that subtree — never :root, never the
// real app.
export function toScopedVars(tokens: ResolvedTokens, mode: "light" | "dark"): Record<string, string> {
  const palette = tokens[mode];
  const vars: Record<string, string> = {};
  for (const role of ROLE_NAMES) {
    vars[`--color-brand-${role}`] = palette[role];
  }
  return vars;
}

/**
 * Client-side live preview of the in-progress canon draft. Resolves the draft
 * through the pure resolver, scopes the result to a local `.brand-surface`
 * wrapper via inline style vars, and offers its own light/dark toggle (local
 * state — independent of the app-wide ThemeToggle/`data-theme` mechanism).
 */
export default function BrandPreview({ draft }: { draft: BrandCanon }) {
  const [mode, setMode] = useState<"light" | "dark">("light");

  let tokens: ResolvedTokens | null = null;
  let error: string | null = null;
  try {
    tokens = resolveTokens(draft);
  } catch (err) {
    error = err instanceof Error ? err.message : "Unable to resolve draft tokens";
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Live preview</h3>
        <div className="flex items-center gap-1" role="group" aria-label="Preview theme">
          {(["light", "dark"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setMode(option)}
              aria-pressed={mode === option}
              className={`btn-xxs ${mode === option ? "btn-primary" : "btn-secondary"}`}
            >
              {option === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
      </div>

      {error || !tokens ? (
        <p className="text-sm text-danger">{error ?? "Unable to resolve draft tokens"}</p>
      ) : (
        <div
          className="brand-surface rounded-lg border border-brand-line p-4"
          style={toScopedVars(tokens, mode)}
        >
          <div className="mb-4">
            <span className="font-brand-wordmark text-xl tracking-wide text-brand-primary">
              {draft.brandName}
            </span>
          </div>

          <div className="grid grid-cols-4 gap-2 mb-4">
            {ROLE_NAMES.map((role) => (
              <div key={role} className="flex flex-col gap-1">
                <div className={`h-8 rounded border border-brand-line ${ROLE_SWATCH_CLASS[role]}`} />
                <span className="text-2xs font-brand-body text-brand-content-muted truncate">
                  {role}
                </span>
              </div>
            ))}
          </div>

          {/* Display-face specimen — the draft's Ethos introduction, so edits
              to it show up here live. */}
          <div className="mb-4">
            <p className="font-brand-display text-lg text-brand-high-contrast">
              {firstParagraph(draft, "ethos")}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="inline-flex items-center rounded px-3 py-1 text-xs font-brand-body bg-brand-primary text-brand-on-primary">
              Primary action
            </span>
            <span className="inline-flex items-center rounded border border-brand-line-strong px-3 py-1 text-xs font-brand-body text-brand-content">
              Secondary action
            </span>
            <span className="inline-flex items-center rounded px-3 py-1 text-xs font-brand-body bg-brand-accent text-brand-on-accent">
              Accent
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
