"use client";

import type { BrandCanon, RoleName } from "@/lib/brand/canon.types";
import { deriveDarkPalette } from "@/lib/brand/deriveDark";

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

const CUSTOM_HEX = "__custom__";

// Same light-role resolution as lib/brand/tokens.ts's (unexported) resolveLight:
// a role maps to either a palette key (resolved to its hex) or a raw hex.
function resolveLight(draft: BrandCanon): Record<RoleName, string> {
  const paletteByKey = new Map(draft.palette.map((c) => [c.key, c.hex]));
  const out = {} as Record<RoleName, string>;
  for (const role of ROLE_NAMES) {
    const value = draft.roleMap.light[role];
    out[role] = paletteByKey.get(value) ?? value ?? "#000000";
  }
  return out;
}

/**
 * Per-role theme mapping. Light: assign a palette key (or fall back to a raw
 * custom hex). Dark: shows the auto-derived baseline (deriveDarkPalette) and
 * lets the user set a sparse override, with a reset back to derived.
 */
export default function ThemeFacet({
  draft,
  onChange,
}: {
  draft: BrandCanon;
  onChange: (next: BrandCanon) => void;
}) {
  const resolvedLight = resolveLight(draft);
  const derivedDark = deriveDarkPalette(resolvedLight);
  const paletteKeys = draft.palette.map((c) => c.key);

  function setLight(role: RoleName, value: string) {
    onChange({
      ...draft,
      roleMap: { ...draft.roleMap, light: { ...draft.roleMap.light, [role]: value } },
    });
  }

  function setDarkOverride(role: RoleName, hex: string) {
    onChange({
      ...draft,
      roleMap: { ...draft.roleMap, dark: { ...draft.roleMap.dark, [role]: hex } },
    });
  }

  function resetDarkOverride(role: RoleName) {
    const dark = { ...draft.roleMap.dark };
    delete dark[role];
    onChange({ ...draft, roleMap: { ...draft.roleMap, dark } });
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Theme</h3>
      <div className="flex flex-col gap-2">
        {ROLE_NAMES.map((role) => {
          const lightValue = draft.roleMap.light[role] ?? "";
          const isPaletteKey = paletteKeys.includes(lightValue);
          const override = draft.roleMap.dark[role];
          const derived = derivedDark[role];

          return (
            <div
              key={role}
              className="grid grid-cols-[7rem_1fr_1fr] items-center gap-3 bg-surface-mid border border-line rounded-md p-2"
            >
              <span className="text-xs text-secondary">{role}</span>

              <div className="flex items-center gap-2">
                <select
                  className="inp-sm"
                  value={isPaletteKey ? lightValue : CUSTOM_HEX}
                  onChange={(e) => {
                    const next = e.target.value;
                    setLight(role, next === CUSTOM_HEX ? resolvedLight[role] : next);
                  }}
                >
                  {paletteKeys.map((key) => (
                    <option key={key} value={key}>
                      {draft.palette.find((c) => c.key === key)?.name ?? key}
                    </option>
                  ))}
                  <option value={CUSTOM_HEX}>Custom hex…</option>
                </select>
                {!isPaletteKey && (
                  <input
                    className="inp-sm w-24"
                    value={lightValue}
                    onChange={(e) => setLight(role, e.target.value)}
                    placeholder="#rrggbb"
                  />
                )}
              </div>

              <div className="flex items-center gap-2">
                <span
                  className="h-6 w-6 shrink-0 rounded border border-line-strong"
                  style={{ background: derived }}
                  title={`Derived: ${derived}`}
                />
                <input
                  className="inp-sm w-24"
                  value={override ?? ""}
                  onChange={(e) => {
                    const next = e.target.value;
                    if (next.trim() === "") {
                      resetDarkOverride(role);
                    } else {
                      setDarkOverride(role, next);
                    }
                  }}
                  placeholder={derived}
                />
                {override !== undefined && (
                  <button
                    type="button"
                    className="btn-secondary btn-xxs shrink-0"
                    onClick={() => resetDarkOverride(role)}
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
