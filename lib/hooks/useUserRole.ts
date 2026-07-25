"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";
import { queryKeys } from "@/lib/query-keys";
import type { UserRole, Capability } from "@/lib/auth";
import { can } from "@/lib/auth/resolve";
import type { ScopeGrants } from "@/lib/auth/resolve";

interface Me {
  user: { id: string; email: string } | null;
  role: UserRole | null;
  grants: ScopeGrants;
}

/**
 * Shared auth query. NavBar, SubNav, and the active tab all call useUserRole;
 * TanStack Query dedups them into one in-flight `/api/auth/me` request and
 * serves the rest from cache. Role is stable for the session, so it never
 * goes stale on its own (invalidate queryKeys.auth.all() on sign-in/out).
 */
export function useAuthMeQuery() {
  return useQuery({
    queryKey: queryKeys.auth.me(),
    queryFn: () => fetchJson<Me>("/api/auth/me"),
    staleTime: Infinity,
  });
}

export function useUserRole(): Omit<Me, "grants"> & { loading: boolean } {
  const { data, isLoading } = useAuthMeQuery();
  return {
    user: data?.user ?? null,
    role: data?.role ?? null,
    loading: isLoading,
  };
}

/**
 * Client-side affordance check — wraps useAuthMeQuery and runs the *same*
 * resolve.ts `can` the server uses, so the client cannot drift from the
 * server. This governs affordance only; the server route remains the gate.
 */
export function usePermissions(): { can: (cap: Capability) => boolean; role: UserRole | null; loading: boolean } {
  const { data, isLoading } = useAuthMeQuery();
  const grants = data?.grants ?? {};
  return {
    can: (cap: Capability) => can(grants, cap.scope, cap.level),
    role: data?.role ?? null,
    loading: isLoading,
  };
}
