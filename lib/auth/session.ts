import type { User } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "../supabase/server";
import type { ScopeGrants } from "./resolve";
import { ROLE_BUNDLES, type UserRole } from "./roleGrants";

export interface Session {
  user: User;
  role: UserRole;
  grants: ScopeGrants;
}

/**
 * Returns the authenticated user + their resolved scope grants, or null if
 * not logged in. Grants are consulted from user_permission_grants only when
 * role === "custom" — the four static roles resolve straight from
 * ROLE_BUNDLES and never touch that table.
 */
export async function getSessionUser(): Promise<Session | null> {
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

  const role = (profile?.role ?? "viewer") as UserRole;

  if (role === "custom") {
    const { data: rows } = await supabase
      .from("user_permission_grants")
      .select("scope, level")
      .eq("user_id", user.id);

    const grants: ScopeGrants = Object.fromEntries(
      (rows ?? []).map((r: { scope: string; level: string }) => [r.scope, r.level]),
    );
    return { user, role, grants };
  }

  return { user, role, grants: ROLE_BUNDLES[role] };
}
