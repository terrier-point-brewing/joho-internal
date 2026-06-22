import { createSupabaseServerClient } from "./supabase/server";

export type UserRole = "viewer" | "brewer" | "manager" | "admin";

/** Returns the authenticated user + their role, or null if not logged in. */
export async function getSessionUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  return { user, role: (profile?.role ?? "viewer") as UserRole };
}

/**
 * Throws a 401/403 Response unless the caller's role is in allowedRoles.
 *
 * "admin" is always implicitly allowed and must never be listed explicitly
 * by callers. Pass an empty array to require admin only. manager and brewer
 * are scoped siblings (taproom vs. production), not a hierarchy — there is
 * no rank between them, so callers must name every non-admin role they want
 * to allow, not rely on a floor/ceiling comparison.
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
