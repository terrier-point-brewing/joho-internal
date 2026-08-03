"use client";

import type { BrandCanon, RoleName } from "@/lib/brand/canon.types";
import { deriveDarkPalette } from "@/lib/brand/deriveDark";
import { suggestDarkRoles } from "@/lib/brand/suggestDark";
import Badge from "@/app/components/ui/Badge";
import Banner from "@/app/components/ui/Banner";

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
// A dark role with no stored value falls back to the runtime derivation.
const UNSET = "__unset__";

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

  const suggestions = suggestDarkRoles(draft);
  const snapCount = suggestions.filter((s) => s.verdict === "snap" && s.nearestKey).length;
  const needsNewColors = suggestions.filter((s) => s.verdict === "add");

  function setLight(role: RoleName, value: string) {
    onChange({
      ...draft,
      roleMap: { ...draft.roleMap, light: { ...draft.roleMap.light, [role]: value } },
    });
  }

  function setDark(role: RoleName, value: string) {
    onChange({
      ...draft,
      roleMap: { ...draft.roleMap, dark: { ...draft.roleMap.dark, [role]: value } },
    });
  }

  function resetDark(role: RoleName) {
    const dark = { ...draft.roleMap.dark };
    delete dark[role];
    onChange({ ...draft, roleMap: { ...draft.roleMap, dark } });
  }

  /**
   * Binds every role that has a confident palette match in one go.
   *
   * Roles the suggester can't place are deliberately left alone rather than
   * bound to a near-enough color: those are the ones that need a NEW palette
   * entry, and quietly snapping them is how a dark mode ends up subtly wrong
   * in ways nobody can point at.
   */
  function applySuggestions() {
    const dark = { ...draft.roleMap.dark };
    for (const s of suggestions) {
      if (s.verdict === "snap" && s.nearestKey) dark[s.role] = s.nearestKey;
    }
    onChange({ ...draft, roleMap: { ...draft.roleMap, dark } });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Theme</h3>
          <p className="text-xs text-muted mt-1">
            Each UI role binds to a palette color in both modes — edit a hex in Palette and every
            role linked to it follows. &ldquo;Custom hex&rdquo; detaches a role. A dark role left
            unset is still computed from light at render time.
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary shrink-0"
          onClick={applySuggestions}
          disabled={snapCount === 0}
          title="Bind every dark role that has a close palette match"
        >
          Auto-derive dark ({snapCount})
        </button>
      </div>

      {needsNewColors.length > 0 && (
        <Banner tone="info">
          <span className="font-medium">
            {needsNewColors.length} dark {needsNewColors.length === 1 ? "role has" : "roles have"} no
            close palette match.
          </span>{" "}
          Auto-derive will skip{" "}
          {needsNewColors.map((s) => s.role).join(", ")} — each needs a new palette color rather
          than being snapped to something near enough.{" "}
          {needsNewColors
            .slice(0, 3)
            .map(
              (s) =>
                `${s.role} → ${s.derived}${
                  s.reason === "would-collide"
                    ? ` (would collide with ${s.nearestKey})`
                    : s.nearestKey
                      ? ` (nearest ${s.nearestKey}, ΔE ${s.distance.toFixed(2)})`
                      : ""
                }`,
            )
            .join(" · ")}
        </Banner>
      )}

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

          const darkValue = draft.roleMap.dark?.[role] ?? "";
          const darkIsPaletteKey = paletteKeys.includes(darkValue);
          const darkHex = darkValue
            ? (draft.palette.find((c) => c.key === darkValue)?.hex ?? darkValue)
            : derivedDark[role];

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

              {/* Dark mirrors light: bind to a palette color, or detach to a
                  raw hex. Dark used to be a sparse set of raw-hex overrides
                  computed at render time, which meant its colors existed
                  nowhere in the palette — unnameable, and invisible in the
                  guide. */}
              <div className="flex items-center gap-2">
                {darkIsPaletteKey ? (
                  <span
                    className="h-6 w-6 shrink-0 rounded border border-line-strong"
                    style={{ background: darkHex }}
                    title={`${darkValue} → ${darkHex}`}
                  />
                ) : (
                  <input
                    type="color"
                    value={pickerSafe(darkHex)}
                    onChange={(e) => setDark(role, e.target.value)}
                    className="h-6 w-6 shrink-0 rounded border border-line-strong bg-transparent cursor-pointer"
                    aria-label={`${role} dark custom color`}
                  />
                )}
                <select
                  className="inp-sm"
                  value={darkIsPaletteKey ? darkValue : darkValue ? CUSTOM_HEX : UNSET}
                  onChange={(e) => {
                    const next = e.target.value;
                    if (next === UNSET) resetDark(role);
                    else setDark(role, next === CUSTOM_HEX ? darkHex : next);
                  }}
                >
                  <option value={UNSET}>Derived (not set)</option>
                  {paletteKeys.map((key) => (
                    <option key={key} value={key}>
                      {draft.palette.find((c) => c.key === key)?.name ?? key}
                    </option>
                  ))}
                  <option value={CUSTOM_HEX}>Custom hex…</option>
                </select>
                {!darkValue && <span className="text-2xs text-faint shrink-0">auto</span>}
                {darkValue && !darkIsPaletteKey && (
                  <Badge tone="accent" className="shrink-0">detached</Badge>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
