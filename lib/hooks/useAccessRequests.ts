"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";
import { queryKeys } from "@/lib/query-keys";
import { usePermissions } from "@/lib/hooks/useUserRole";
import { CAP } from "@/lib/auth/capabilities";

export interface AccessRequest {
  id: string;
  name: string;
  email: string;
  reason: string | null;
  status: "pending" | "approved" | "denied";
  created_at: string;
}

/**
 * The access-request list. The sidebar badge and the Access Requests table both
 * read it through this hook, so they share one cache entry — approving a
 * request in the table clears it from the badge without a second fetch.
 *
 * Gated on the same capability the route enforces: a user who cannot manage
 * users never issues the request at all, rather than firing it and swallowing
 * a 403.
 */
export function useAccessRequests() {
  const { can } = usePermissions();
  const enabled = can(CAP.usersManage);

  const query = useQuery({
    queryKey: queryKeys.admin.requests(),
    queryFn: () => fetchJson<AccessRequest[]>("/api/admin/requests"),
    enabled,
  });

  return query;
}

/** Count of requests still awaiting a decision — drives the sidebar badge. */
export function usePendingAccessRequestCount(): number {
  const { data } = useAccessRequests();
  return (data ?? []).filter((r) => r.status === "pending").length;
}
