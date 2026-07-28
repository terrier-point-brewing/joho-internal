import type { User } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "../supabase/server";
import type { ScopeGrants } from "./resolve";
import { getRoleBundle } from "./roleBundles.server";
import { type UserRole } from "./roleGrants";

export interface Session {
  user: User;
  role: UserRole;
  grants: ScopeGrants;
}

/**
 * Returns the authenticated user + their resolved scope grants, or null if
 * not logged in.
 *
 * Two grant sources, never mixed: role === "custom" resolves from that user's
 * own user_permission_grants rows; every other role resolves from its editable
 * bundle in role_permission_grants (cached, and falling back to the
 * ROLE_BUNDLES constant if that table cannot be read).
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

  return { user, role, grants: await getRoleBundle(role) };
}
