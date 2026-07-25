// Barrel — preserves the @/lib/auth import path the ~211 existing call
// sites use. lib/auth.ts is retired in favor of this directory.
export { getSessionUser } from "./session";
export type { Session } from "./session";

export { requirePermission } from "./guard";

export { can, effectiveLevel } from "./resolve";
export type { ScopeGrants } from "./resolve";

export { CAP } from "./capabilities";
export type { Capability } from "./capabilities";

export { ROLE_BUNDLES } from "./roleGrants";
export type { UserRole } from "./roleGrants";

export { SCOPES, ROOT } from "./scopes";
export type { ScopeKey, Section } from "./scopes";

export { RANK } from "./levels";
export type { Level } from "./levels";

import { getSessionUser } from "./session";
import type { UserRole } from "./roleGrants";

/**
 * @deprecated Superseded by requirePermission. Kept, with its exact 401/403
 * contract, until every call site is converted to requirePermission — a
 * later group removes it. "admin" is always implicitly allowed and must
 * never be listed explicitly by callers.
 */
export async function requireRole(allowedRoles: UserRole[]): Promise<void> {
  const session = await getSessionUser();

  if (!session) {
    throw new Response("Unauthorized", { status: 401 });
  }

  if (session.role !== "admin" && !allowedRoles.includes(session.role)) {
    throw new Response("Forbidden", { status: 403 });
  }
}
