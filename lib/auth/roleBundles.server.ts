import { createSupabaseAdminClient } from "../supabase/admin";
import type { Level } from "./levels";
import type { ScopeGrants } from "./resolve";
import { ROLE_BUNDLES, type UserRole } from "./roleGrants";

interface RoleGrantRow {
  role: UserRole;
  scope: string;
  level: Level;
}

/**
 * Preset-role bundles, read from role_permission_grants so they can be edited
 * without a deploy. ROLE_BUNDLES stays in the tree as the seed and as the
 * fallback below — it is not dead code.
 *
 * Cached in-process for CACHE_TTL_MS. getSessionUser() runs on essentially
 * every page and API route, and static roles previously cost ZERO grant
 * queries; without a cache this change would add one per request forever. The
 * table is tiny and shared, so a short TTL is the right trade: an edit is live
 * within the TTL on every instance, immediately on the one that served it.
 * The bound on staleness is deliberate and small — this is not a permission
 * check being skipped, it is a bundle being at most 30s old.
 */
const CACHE_TTL_MS = 30_000;

let cache: { at: number; bundles: Record<string, ScopeGrants> } | null = null;

export function invalidateRoleBundles(): void {
  cache = null;
}

/**
 * Returns the bundle for `role`.
 *
 * Falls back to the ROLE_BUNDLES constant when the table cannot be read at
 * all — which is the normal state before 20260826 is applied, since prod
 * migrations here are human-gated and may lag the deploy. Failing CLOSED would
 * lock every user out of everything on a transient DB blip or an unapplied
 * migration; the constant is the known-good baseline, so failing back to it is
 * both safer and behaviour-preserving.
 *
 * A successful read that returns NO rows for a role is honoured as an empty
 * bundle, not treated as failure: emptying a role is a legitimate edit.
 */
export async function getRoleBundle(role: UserRole): Promise<ScopeGrants> {
  if (role === "custom") return ROLE_BUNDLES.custom;

  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return cache.bundles[role] ?? {};
  }

  let rows: RoleGrantRow[];
  try {
    // try/catch, not just the { error } channel: createSupabaseAdminClient()
    // THROWS when SUPABASE_SERVICE_ROLE_KEY is absent. Letting that propagate
    // would 500 every authenticated request in an environment that has never
    // needed the service key before — the fail-closed outcome this fallback
    // exists to prevent.
    const { data, error } = await createSupabaseAdminClient()
      .from("role_permission_grants")
      .select("role, scope, level");
    if (error || !data) return ROLE_BUNDLES[role];
    rows = data as RoleGrantRow[];
  } catch {
    // Do not cache a failure — the next request should retry rather than serve
    // the fallback for a full TTL.
    return ROLE_BUNDLES[role];
  }

  const bundles: Record<string, ScopeGrants> = {};
  for (const row of rows) {
    (bundles[row.role] ??= {})[row.scope as keyof ScopeGrants] = row.level;
  }
  cache = { at: now, bundles };

  return bundles[role] ?? {};
}
