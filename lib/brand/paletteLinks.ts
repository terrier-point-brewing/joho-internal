import type { BrandCanon, RoleName } from "./canon.types";

/**
 * The palette ↔ theme index.
 *
 * Promoted out of PaletteFacet's inline loop so the guide view and the editor
 * share one implementation. The Color tab's bidirectional highlight — click a
 * swatch, see every role it drives; click a role, see its source — only works
 * if both sides agree on what "drives" means.
 */

export type ThemeMode = "light" | "dark";

/** Which roles bind to each palette key, in the given mode. */
export function rolesByPaletteKey(
  canon: BrandCanon,
  mode: ThemeMode,
): Map<string, RoleName[]> {
  const map = new Map<string, RoleName[]>();
  const roleMap = canon.roleMap[mode] ?? {};

  for (const [role, value] of Object.entries(roleMap)) {
    if (typeof value !== "string") continue;
    // A raw hex is a detached role — it has no palette key to index under.
    if (!isPaletteKey(value, canon)) continue;
    map.set(value, [...(map.get(value) ?? []), role as RoleName]);
  }

  return map;
}

/** True when a roleMap value names a palette color rather than a raw hex. */
export function isPaletteKey(value: string, canon: BrandCanon): boolean {
  return canon.palette.some((c) => c.key === value);
}

/**
 * What a role resolves to, and whether it is linked or detached.
 *
 * `detached` roles stop following palette edits, which is exactly the kind of
 * thing that should be visible in the guide rather than discovered later.
 */
export function resolveRole(
  canon: BrandCanon,
  mode: ThemeMode,
  role: RoleName,
): { hex: string; key: string | null; detached: boolean } | null {
  const value = canon.roleMap[mode]?.[role];
  if (typeof value !== "string") return null;

  const color = canon.palette.find((c) => c.key === value);
  if (color) return { hex: color.hex, key: color.key, detached: false };
  return { hex: value, key: null, detached: true };
}
