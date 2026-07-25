import type { Capability } from "./capabilities";
import { can } from "./resolve";
import { getSessionUser, type Session } from "./session";

/**
 * Throws a 401/403 Response unless the caller's grants satisfy the
 * capability. Same contract as the legacy requireRole: no session -> 401,
 * insufficient grant -> 403. Callers use
 * `try { await requirePermission(...) } catch (res) { return res as Response; }`.
 */
export async function requirePermission(cap: Capability): Promise<Session> {
  const session = await getSessionUser();

  if (!session) {
    throw new Response("Unauthorized", { status: 401 });
  }

  if (!can(session.grants, cap.scope, cap.level)) {
    throw new Response("Forbidden", { status: 403 });
  }

  return session;
}
