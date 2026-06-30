"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";
import { queryKeys } from "@/lib/query-keys";
import type { UserRole } from "@/lib/auth";

interface Me {
  user: { id: string; email: string } | null;
  role: UserRole | null;
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

export function useUserRole(): Me & { loading: boolean } {
  const { data, isLoading } = useAuthMeQuery();
  return {
    user: data?.user ?? null,
    role: data?.role ?? null,
    loading: isLoading,
  };
}
