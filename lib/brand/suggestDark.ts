import type { BrandCanon, RoleName } from "./canon.types";
import { deriveDarkPalette } from "./deriveDark";
import { SNAP_THRESHOLD, nearestKey } from "./colorDistance";
import { ROLE_NAMES, resolveLightRoles } from "./tokens";

/**
 * Dark-mode suggestions for the canon editor.
 *
 * `deriveDarkPalette` used to run on every render, which meant dark mode existed
 * nowhere in the palette: its colors could not be named, given a use case, or
 * even looked at. Here it becomes a one-shot suggestion engine behind a button —
 * an admin sees what it proposes, with its confidence, and accepts per role.
 *
 * It is a suggestion engine and never an authority. It optimises one role at a
 * time against a mechanical HSL treatment and cannot see, for instance, that
 * Indigo-and-Paper already contain a perfectly good dark mode.
 */

export interface DarkSuggestion {
  role: RoleName;
  /** What the HSL treatment produces for this role. */
  derived: string;
  /**
   * Closest existing palette color. Reported even when the verdict is `add`,
   * so the editor can explain itself — "nearest is Seal Red at ΔE 0.15" is a
   * far better prompt than an unexplained "add a new color".
   */
  nearestKey: string | null;
  distance: number;
  /** `snap` binds to nearestKey; `add` means the palette needs a new entry. */
  verdict: "snap" | "add";
  /** Why an `add` verdict was reached. Absent when the verdict is `snap`. */
  reason?: "no-close-match" | "would-collide";
}

/**
 * Role pairs that must stay visually distinct.
 *
 * Nearest-match runs per role, so two roles can independently pick the same
 * palette color — each match defensible alone, the pair collapsing a real
 * distinction. `surface` and `surface-raised` both snapping to Indigo would
 * flatten two elevation levels into one.
 *
 * `surface-raised`/`line` is deliberately absent: they share a key in both
 * modes by design, exactly as Paper 3 already does in light.
 */
const DISTINCT_PAIRS: [RoleName, RoleName][] = [
  ["canvas", "surface"],
  ["surface", "surface-raised"],
  ["surface-raised", "line-strong"],
];

export function suggestDarkRoles(canon: BrandCanon): DarkSuggestion[] {
  const light = resolveLightRoles(canon);
  const derived = deriveDarkPalette(light);
  const palette = canon.palette.map((c) => ({ key: c.key, hex: c.hex }));

  const suggestions: DarkSuggestion[] = ROLE_NAMES.map((role) => {
    const hex = derived[role];
    const match = nearestKey(hex, palette);
    const close = !!match && match.distance <= SNAP_THRESHOLD;
    return {
      role,
      derived: hex,
      nearestKey: match?.key ?? null,
      distance: match?.distance ?? Number.POSITIVE_INFINITY,
      verdict: close ? "snap" : "add",
      ...(close ? {} : { reason: "no-close-match" as const }),
    };
  });

  return applyCollisionGuard(suggestions);
}

/**
 * Demotes the second of any two distinct-pair roles that snapped to one key.
 * Whichever matched less closely gives way, so the better match keeps its bind.
 */
function applyCollisionGuard(suggestions: DarkSuggestion[]): DarkSuggestion[] {
  const byRole = new Map(suggestions.map((s) => [s.role, { ...s }]));

  for (const [a, b] of DISTINCT_PAIRS) {
    const first = byRole.get(a);
    const second = byRole.get(b);
    if (!first || !second) continue;
    if (first.verdict !== "snap" || second.verdict !== "snap") continue;
    if (first.nearestKey !== second.nearestKey) continue;

    const loser = first.distance <= second.distance ? second : first;
    loser.verdict = "add";
    loser.reason = "would-collide";
    // nearestKey is kept: the editor needs it to say WHICH role this would
    // have collided with, and a bare "add" with no context is unactionable.
  }

  return ROLE_NAMES.map((role) => byRole.get(role)!);
}
