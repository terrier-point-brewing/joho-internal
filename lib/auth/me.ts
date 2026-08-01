import type { ScopeGrants } from "./resolve";
import type { UserRole } from "./roleGrants";
import type { Session } from "./session";

/**
 * The wire shape of the current user's identity + grants: what `/api/auth/me`
 * returns and what the root layout seeds the client query cache with.
 *
 * Type-only imports throughout, so this module stays client-safe (the hook
 * imports the interface) even though `Session` originates in a file that
 * reaches `next/headers`.
 */
export interface AuthMe {
  user: { id: string; email: string } | null;
  role: UserRole | null;
  grants: ScopeGrants;
}

/**
 * Narrows a server Session to the wire shape. Both producers go through here
 * so the seeded cache entry and the API response can never disagree — a
 * disagreement would put the server render and the first client render out of
 * step again, which is exactly the hydration mismatch this exists to prevent.
 */
export function toAuthMe(session: Session | null): AuthMe {
  if (!session) return { user: null, role: null, grants: {} };
  return {
    user: { id: session.user.id, email: session.user.email ?? "" },
    role: session.role,
    grants: session.grants,
  };
}
