"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";

interface AccountRequest {
  id: string;
  name: string;
  email: string;
  reason: string | null;
  status: "pending" | "approved" | "denied";
  created_at: string;
}

const QUERY_KEY = ["admin", "requests"] as const;

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
      <h2 className="text-base font-semibold text-zinc-100 mb-6">Access Requests</h2>

      {isLoading && <p className="text-sm text-zinc-500">Loading…</p>}
      {(error || action.error) && (
        <p className="text-sm text-red-400 bg-red-950/30 border border-red-900/50 rounded px-3 py-2 mb-4">
          {(error as Error)?.message ?? (action.error as Error)?.message ?? "Unknown error"}
        </p>
      )}

      {!isLoading && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-500 text-xs uppercase tracking-wide">
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
                <tr key={r.id} className="border-b border-zinc-800/50 last:border-0">
                  <td className="px-4 py-3 text-zinc-200">{r.name}</td>
                  <td className="px-4 py-3 text-zinc-400">{r.email}</td>
                  <td className="px-4 py-3 text-zinc-500 max-w-xs truncate">{r.reason ?? "—"}</td>
                  <td className="px-4 py-3 text-zinc-500">
                    {new Date(r.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded ${
                        r.status === "pending"
                          ? "text-amber-400 bg-amber-900/30"
                          : r.status === "approved"
                          ? "text-green-400 bg-green-900/30"
                          : "text-zinc-500 bg-zinc-800"
                      }`}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {r.status === "pending" && (
                      <div className="flex gap-2 justify-end">
                        <button
                          onClick={() => action.mutate({ id: r.id, status: "approved" })}
                          disabled={action.isPending}
                          className="text-xs px-2 py-1 rounded bg-green-900/30 text-green-400 hover:bg-green-900/50 transition-colors disabled:opacity-50"
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => action.mutate({ id: r.id, status: "denied" })}
                          disabled={action.isPending}
                          className="text-xs px-2 py-1 rounded bg-zinc-800 text-zinc-500 hover:text-red-400 transition-colors disabled:opacity-50"
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
                  <td colSpan={6} className="px-4 py-6 text-center text-zinc-600 text-sm">
                    No access requests
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
