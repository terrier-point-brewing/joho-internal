"use client";

import { useMemo } from "react";
import type { BrandCanon, FontRole } from "@/lib/brand/canon.types";
import { BUNDLED_FONTS, sourceOf, type FontSource } from "@/lib/brand/fontRegistry";
import { useAssets } from "@/app/brand/assets/useAssets";

const FONT_ROLES: FontRole[] = ["display", "body", "wordmark", "script"];
const SOURCES: FontSource[] = ["bundled", "uploaded", "system"];

/**
 * Per-role typeface assignment.
 *
 * Registering a face is open-ended (bundled, uploaded, or a system stack);
 * assigning one to a role is not. The four roles stay fixed because the whole
 * app skin binds to `--font-brand-{display,body,wordmark,script}` — widening
 * that enum would ripple far beyond the Brand Guide for no visible gain.
 *
 * ⚠️ Before phase 5 these selections did NOTHING: globals.css hardcoded the
 * font tokens and emitBrandCss deliberately skipped them, so assigning Lato to
 * `display` left the guide rendering Marcellus. The canon now emits the
 * mapping, so a change here reaches the page.
 */
export default function TypeFacet({
  draft,
  onChange,
}: {
  draft: BrandCanon;
  onChange: (next: BrandCanon) => void;
}) {
  const { data: allAssets } = useAssets("font");
  const fontAssets = useMemo(() => allAssets ?? [], [allAssets]);

  function patchFont(role: FontRole, patch: Partial<BrandCanon["fonts"][number]>) {
    const existing = draft.fonts.find((f) => f.role === role);
    const base = existing ?? { role, family: "", cssStack: "", weights: [400] };
    const next = { ...base, ...patch };
    const fonts = existing
      ? draft.fonts.map((f) => (f.role === role ? next : f))
      : [...draft.fonts, next];
    onChange({ ...draft, fonts });
  }

  /** Picking a bundled family sets its family and matching fallback together. */
  function setBundled(role: FontRole, family: string) {
    const option = BUNDLED_FONTS.find((f) => f.family === family);
    if (!option) return;
    patchFont(role, {
      source: "bundled",
      family: option.family,
      cssStack: `"${option.family}", ${option.fallback}`,
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Type</h3>
        <p className="text-xs text-muted mt-1">
          One face per role. Bundled families are loaded by the app; uploaded faces are served
          from the asset library as @font-face; a system stack uses whatever is on the device.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {FONT_ROLES.map((role) => {
          const entry = draft.fonts.find((f) => f.role === role);
          const source = entry ? sourceOf(entry) : "bundled";

          return (
            <div
              key={role}
              className="flex flex-col gap-2 bg-surface-mid border border-line rounded-md p-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-secondary w-20 shrink-0">{role}</span>

                <select
                  className="inp-sm w-28 shrink-0"
                  value={source}
                  onChange={(e) => patchFont(role, { source: e.target.value as FontSource })}
                  aria-label={`${role} source`}
                >
                  {SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>

                {source === "bundled" ? (
                  <select
                    className="inp-sm flex-1 min-w-40"
                    value={entry?.family ?? ""}
                    onChange={(e) => setBundled(role, e.target.value)}
                    aria-label={`${role} family`}
                  >
                    <option value="" disabled>
                      Choose a family…
                    </option>
                    {BUNDLED_FONTS.map((f) => (
                      <option key={f.family} value={f.family}>
                        {f.family}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="inp-sm flex-1 min-w-40"
                    value={entry?.family ?? ""}
                    onChange={(e) => patchFont(role, { family: e.target.value })}
                    placeholder="Family name"
                    aria-label={`${role} family`}
                  />
                )}

                {entry && (
                  <span className="text-lg text-primary" style={{ fontFamily: entry.cssStack }}>
                    Aa
                  </span>
                )}
              </div>

              {source !== "bundled" && (
                <input
                  className="inp-sm"
                  value={entry?.cssStack ?? ""}
                  onChange={(e) => patchFont(role, { cssStack: e.target.value })}
                  placeholder={'"Family Name", sans-serif'}
                  aria-label={`${role} CSS stack`}
                />
              )}

              {source === "uploaded" && (
                <>
                  <label className="flex flex-col gap-1">
                    <span className="text-2xs uppercase tracking-wide text-muted">
                      Font files ({(entry?.assetIds ?? []).length} attached · ⌘-click to
                      multi-select)
                    </span>
                    <select
                      multiple
                      className="inp-sm min-h-16"
                      value={entry?.assetIds ?? []}
                      onChange={(e) =>
                        patchFont(role, {
                          assetIds: Array.from(e.target.selectedOptions, (o) => o.value),
                        })
                      }
                    >
                      {fontAssets.map((asset) => (
                        <option key={asset.id} value={asset.id}>
                          {asset.title || asset.variant} · {asset.format} · {asset.status}
                        </option>
                      ))}
                    </select>
                  </label>
                  {fontAssets.length === 0 && (
                    <p className="text-2xs text-faint">
                      No font files uploaded yet — add them in the Assets tab with kind
                      &ldquo;font&rdquo;.
                    </p>
                  )}
                  <input
                    className="inp-sm"
                    value={entry?.license ?? ""}
                    onChange={(e) => patchFont(role, { license: e.target.value || undefined })}
                    placeholder="Licence — uploaded faces are served by this app"
                    aria-label={`${role} licence`}
                  />
                </>
              )}
              {/* Cap height, measured per face. Needed to place type by its cap
                  line rather than its font size — a slot specified as "26mm cap
                  height" (the wordmark's stated minimum) cannot be rendered
                  from a size alone. */}
              <input
                className="inp-sm"
                type="number"
                step="0.01"
                min="0.01"
                max="2"
                value={entry?.capHeightRatio ?? ""}
                onChange={(e) =>
                  patchFont(role, {
                    capHeightRatio: e.target.value ? Number(e.target.value) : undefined,
                  })
                }
                placeholder="Cap height ÷ em — e.g. 0.70"
                aria-label={`${role} cap-height ratio`}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
