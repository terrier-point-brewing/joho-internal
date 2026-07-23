"use client";

import type { BrandCanon, RoleName } from "@/lib/brand/canon.types";
import { deriveDarkPalette } from "@/lib/brand/deriveDark";
import Badge from "@/app/components/ui/Badge";

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

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Clamp to a value <input type="color"> accepts (it rejects non-#rrggbb). */
function pickerSafe(hex: string): string {
  return HEX_RE.test(hex) ? hex : "#000000";
}

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
 * Per-role theme mapping. Light: assign a palette key (the role then follows
 * palette edits) or detach to a raw custom hex. Dark: auto-derived from the
 * resolved light color (deriveDarkPalette) unless a sparse per-role override
 * is set — the picker/input create an override, Reset returns to derived.
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
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Theme</h3>
        <p className="text-xs text-muted mt-1">
          Each UI role binds to a palette color — edit a hex in Palette and every role linked
          to it follows. Choosing &ldquo;Custom hex&rdquo; detaches the role from the palette.
          Dark is auto-derived from light unless overridden.
        </p>
      </div>

      {/* Column headers */}
      <div className="grid grid-cols-[7rem_1fr_1fr] items-center gap-3 px-2 text-2xs uppercase tracking-wide text-muted">
        <span>Role</span>
        <span>Light</span>
        <span>Dark</span>
      </div>

      <div className="flex flex-col gap-2">
        {ROLE_NAMES.map((role) => {
          const lightValue = draft.roleMap.light[role] ?? "";
          const isPaletteKey = paletteKeys.includes(lightValue);
          const lightHex = resolvedLight[role];
          const override = draft.roleMap.dark[role];
          const derived = derivedDark[role];

          return (
            <div
              key={role}
              className="grid grid-cols-[7rem_1fr_1fr] items-center gap-3 bg-surface-mid border border-line rounded-md p-2"
            >
              <span className="text-xs text-secondary">{role}</span>

              <div className="flex items-center gap-2">
                {isPaletteKey ? (
                  // Linked: static swatch — editing the color belongs to Palette.
                  <span
                    className="h-6 w-6 shrink-0 rounded border border-line-strong"
                    style={{ background: lightHex }}
                    title={`${lightValue} → ${lightHex}`}
                  />
                ) : (
                  // Detached: the swatch doubles as a picker for the raw hex.
                  <input
                    type="color"
                    value={pickerSafe(lightHex)}
                    onChange={(e) => setLight(role, e.target.value)}
                    className="h-6 w-6 shrink-0 rounded border border-line-strong bg-transparent cursor-pointer"
                    aria-label={`${role} light custom color`}
                  />
                )}
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
                  <>
                    <input
                      className="inp-sm w-24"
                      value={lightValue}
                      onChange={(e) => setLight(role, e.target.value)}
                      placeholder="#rrggbb"
                    />
                    <span title="Not linked to a palette color — palette edits won't affect this role">
                      <Badge tone="accent" className="shrink-0">detached</Badge>
                    </span>
                  </>
                )}
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={pickerSafe(override ?? derived)}
                  onChange={(e) => setDarkOverride(role, e.target.value)}
                  className="h-6 w-6 shrink-0 rounded border border-line-strong bg-transparent cursor-pointer"
                  title={override ? `Override: ${override}` : `Derived: ${derived} — picking a color overrides`}
                  aria-label={`${role} dark color`}
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
                {override !== undefined ? (
                  <>
                    <Badge tone="info" className="shrink-0">override</Badge>
                    <button
                      type="button"
                      className="btn-secondary btn-xxs shrink-0"
                      onClick={() => resetDarkOverride(role)}
                    >
                      Reset
                    </button>
                  </>
                ) : (
                  <span className="text-2xs text-faint shrink-0">auto</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
