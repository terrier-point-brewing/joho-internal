"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";
import PageHeader from "@/app/components/PageHeader";
import Banner from "@/app/components/ui/Banner";
import Card from "@/app/components/ui/Card";
import Badge from "@/app/components/ui/Badge";
import type { Tone } from "@/app/components/ui/tone";

interface AccountRequest {
  id: string;
  name: string;
  email: string;
  reason: string | null;
  status: "pending" | "approved" | "denied";
  created_at: string;
}

const QUERY_KEY = ["admin", "requests"] as const;

const STATUS_TONE: Record<AccountRequest["status"], Tone> = {
  pending: "accent",
  approved: "success",
  denied: "neutral",
};

export default function AccessRequests() {
  const qc = useQueryClient();

  const { data: requests = [], isLoading, error } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => fetchJson<AccountRequest[]>("/api/admin/requests"),
  });

  const action = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "approved" | "denied" }) =>
      fetch("/api/admin/requests", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      }).then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? `Failed to ${status} request`);
        }
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <PageHeader title="Access Requests" />

      {isLoading && <p className="text-sm text-muted">Loading…</p>}
      {(error || action.error) && (
        <Banner tone="danger" className="mb-4">
          {(error as Error)?.message ?? (action.error as Error)?.message ?? "Unknown error"}
        </Banner>
      )}

      {!isLoading && (
        <Card padding="" className="overflow-hidden mt-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-muted text-xs uppercase tracking-wide">
                <th className="text-left px-4 py-3 font-medium">Name</th>
                <th className="text-left px-4 py-3 font-medium">Email</th>
                <th className="text-left px-4 py-3 font-medium">Reason</th>
                <th className="text-left px-4 py-3 font-medium">Requested</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id} className="border-b border-line/50 last:border-0">
                  <td className="px-4 py-3 text-strong">{r.name}</td>
                  <td className="px-4 py-3 text-secondary">{r.email}</td>
                  <td className="px-4 py-3 text-muted max-w-xs truncate">{r.reason ?? "—"}</td>
                  <td className="px-4 py-3 text-muted">
                    {new Date(r.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {r.status === "pending" && (
                      <div className="flex gap-2 justify-end">
                        <button
                          onClick={() => action.mutate({ id: r.id, status: "approved" })}
                          disabled={action.isPending}
                          className="text-xs px-2 py-1 rounded bg-success-surface/40 text-success hover:bg-success-surface/60 transition-colors disabled:opacity-50"
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => action.mutate({ id: r.id, status: "denied" })}
                          disabled={action.isPending}
                          className="text-xs px-2 py-1 rounded bg-surface-mid text-muted hover:text-danger transition-colors disabled:opacity-50"
                        >
                          Deny
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {requests.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-faint text-sm">
                    No access requests
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
