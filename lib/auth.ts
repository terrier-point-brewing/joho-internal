import { createSupabaseServerClient } from "./supabase/server";

export type UserRole = "viewer" | "brewer" | "manager" | "admin";

const ROLE_RANK: Record<UserRole, number> = {
  viewer: 0,
  brewer: 1,
  manager: 2,
  admin: 3,
};

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

/** Throws a 401 Response if the caller doesn't meet the minimum role. */
export async function requireRole(minRole: UserRole): Promise<void> {
  const session = await getSessionUser();

  if (!session) {
    throw new Response("Unauthorized", { status: 401 });
  }

  if (ROLE_RANK[session.role] < ROLE_RANK[minRole]) {
    throw new Response("Forbidden", { status: 403 });
  }
}
