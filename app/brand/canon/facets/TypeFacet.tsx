"use client";

import type { BrandCanon, FontRole } from "@/lib/brand/canon.types";

const FONT_ROLES: FontRole[] = ["display", "body", "wordmark", "script"];

// The only families with loaded faces (see app/globals.css --font-brand-* +
// the next/font loaders behind them) — arbitrary families are not allowed
// since they'd silently fall back to a generic serif/sans stack.
const LOADED_FAMILIES: { family: string; cssStack: string }[] = [
  { family: "Marcellus", cssStack: '"Marcellus", serif' },
  { family: "Lato", cssStack: '"Lato", sans-serif' },
  { family: "Jost", cssStack: '"Jost", sans-serif' },
  { family: "Noto Serif SC", cssStack: '"Noto Serif SC", serif' },
];

/**
 * Per-role font family assignment, limited to the 4 loaded families (Marcellus,
 * Lato, Jost, Noto Serif SC) — never arbitrary/unloaded families.
 */
export default function TypeFacet({
  draft,
  onChange,
}: {
  draft: BrandCanon;
  onChange: (next: BrandCanon) => void;
}) {
  function setFamily(role: FontRole, family: string) {
    const option = LOADED_FAMILIES.find((f) => f.family === family);
    if (!option) return;

    const existing = draft.fonts.find((f) => f.role === role);
    const nextEntry = {
      role,
      family: option.family,
      cssStack: option.cssStack,
      weights: existing?.weights ?? [400],
      note: existing?.note,
    };
    const fonts = existing
      ? draft.fonts.map((f) => (f.role === role ? nextEntry : f))
      : [...draft.fonts, nextEntry];
    onChange({ ...draft, fonts });
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Type</h3>
      <div className="flex flex-col gap-2">
        {FONT_ROLES.map((role) => {
          const entry = draft.fonts.find((f) => f.role === role);
          return (
            <div
              key={role}
              className="flex items-center gap-3 bg-surface-mid border border-line rounded-md p-2"
            >
              <span className="text-xs text-secondary w-24 shrink-0">{role}</span>
              <select
                className="inp-sm max-w-xs"
                value={entry?.family ?? ""}
                onChange={(e) => setFamily(role, e.target.value)}
              >
                <option value="" disabled>
                  Choose a family…
                </option>
                {LOADED_FAMILIES.map((f) => (
                  <option key={f.family} value={f.family}>
                    {f.family}
                  </option>
                ))}
              </select>
              {entry && (
                <span
                  className="text-lg text-primary"
                  style={{ fontFamily: entry.cssStack }}
                >
                  Aa
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
