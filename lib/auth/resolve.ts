import { RANK, type Level } from "./levels";
import { ROOT, type ScopeKey, type Section } from "./scopes";

/** One shape, used by both role bundles and user grants. */
export type ScopeGrants = Partial<Record<ScopeKey | Section | typeof ROOT, Level>>;

/**
 * Longest-prefix-wins: a key matches when it is ROOT, equals the scope, or
 * is a dot-prefix of it; the longest matching key supplies the level. The
 * prefix check is dot-delimited, not a bare substring match — "tax" must not
 * match a hypothetical scope "taxes.foo".
 */
export function effectiveLevel(grants: ScopeGrants, scope: ScopeKey): Level | null {
  let best: Level | null = null;
  let bestLen = -1;

  for (const [key, level] of Object.entries(grants) as [string, Level][]) {
    const matches = key === ROOT || scope === key || scope.startsWith(key + ".");
    if (matches && key.length > bestLen) {
      best = level;
      bestLen = key.length;
    }
  }

  return best;
}

export function can(grants: ScopeGrants, scope: ScopeKey, need: Level): boolean {
  const level = effectiveLevel(grants, scope);
  // No special case for "none": it ranks 0, below every real `need`, so the
  // plain comparison already denies access. `level === null` (no grant at
  // all) is handled the same way as `level === "none"` (explicit revoke) —
  // both fail the rank check — while `effectiveLevel` itself keeps the two
  // distinguishable for callers that care (e.g. the grants admin UI).
  return level !== null && RANK[level] >= RANK[need];
}
