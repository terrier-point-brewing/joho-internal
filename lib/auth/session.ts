import { cache } from "react";
import type { User } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "../supabase/server";
import type { ScopeGrants } from "./resolve";
import { getRoleBundle } from "./roleBundles.server";
import { type UserRole } from "./roleGrants";

export interface Session {
  user: User;
  role: UserRole;
  grants: ScopeGrants;
  /**
   * The company an external partner login belongs to; null for every staff
   * login. Portal routes scope every read and write by this and by nothing the
   * browser sends.
   */
  partnerId: string | null;
}

/**
 * Returns the authenticated user + their resolved scope grants, or null if
 * not logged in.
 *
 * Two grant sources, never mixed: role === "custom" resolves from that user's
 * own user_permission_grants rows; every other role resolves from its editable
 * bundle in role_permission_grants (cached, and falling back to the
 * ROLE_BUNDLES constant if that table cannot be read).
 *
 * Memoized per request with React `cache()`. A single page render calls this
 * several times over — the root layout (to seed the nav), the section layout's
 * admission gate, and each requirePage guard below it — and the session cannot
 * change mid-render, so they should cost one auth round trip, not four.
 */
export const getSessionUser = cache(async function getSessionUser(): Promise<Session | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, partner_id")
    .eq("id", user.id)
    .single();

  const role = (profile?.role ?? "viewer") as UserRole;
  const partnerId = (profile as { partner_id?: string | null } | null)?.partner_id ?? null;

  if (role === "custom") {
    const { data: rows } = await supabase
      .from("user_permission_grants")
      .select("scope, level")
      .eq("user_id", user.id);

    const grants: ScopeGrants = Object.fromEntries(
      (rows ?? []).map((r: { scope: string; level: string }) => [r.scope, r.level]),
    );
    return { user, role, grants, partnerId };
  }

  return { user, role, grants: await getRoleBundle(role), partnerId };
});
