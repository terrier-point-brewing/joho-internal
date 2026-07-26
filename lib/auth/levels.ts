export type Level = "none" | "read" | "operate" | "manage" | "admin";

/**
 * Ordered — each level implies every level below it. "none" is rank 0: it is
 * below every real `need`, so a plain rank comparison in `can()` already
 * denies access without a special case. It is a real, storable grant (an
 * explicit revoke) — distinct from no grant existing at all, which
 * `effectiveLevel` reports as `null`.
 */
export const RANK: Record<Level, number> = { none: 0, read: 1, operate: 2, manage: 3, admin: 4 };
