"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import SettingsHeader from "@/app/settings/SettingsHeader";
import Banner from "@/app/components/ui/Banner";
import ListTable from "@/app/components/ui/ListTable";
import Badge from "@/app/components/ui/Badge";
import type { Tone } from "@/app/components/ui/tone";
import { useAccessRequests, type AccessRequest } from "@/lib/hooks/useAccessRequests";
import { queryKeys } from "@/lib/query-keys";

const STATUS_TONE: Record<AccessRequest["status"], Tone> = {
  pending: "accent",
  approved: "success",
  denied: "neutral",
};

export default function AccessRequests() {
  const qc = useQueryClient();

  const { data: requests = [], isLoading, error } = useAccessRequests();

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
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.admin.requests() }),
  });

  return (
    <div className="pane px-4 sm:px-6">
      <SettingsHeader title="Access Requests" />
      <div className="pb-4 sm:pb-8">
      {isLoading && <p className="text-sm text-muted">Loading…</p>}
      {(error || action.error) && (
        <Banner tone="danger" className="mb-4">
          {(error as Error)?.message ?? (action.error as Error)?.message ?? "Unknown error"}
        </Banner>
      )}

      {!isLoading && (
        <ListTable<AccessRequest>
          className="mt-4"
          rows={requests}
          rowKey={(r) => r.id}
          foldBelow="md"
          empty="No access requests"
          cols={[
            { key: "name", header: "Name", role: "label", cell: (r) => r.name },
            { key: "email", header: "Email", className: "text-secondary", cell: (r) => <span className="break-all">{r.email}</span> },
            { key: "reason", header: "Reason", foldBlock: true, className: "text-muted", cell: (r) => r.reason },
            { key: "requested", header: "Requested", className: "text-muted whitespace-nowrap", cell: (r) => new Date(r.created_at).toLocaleDateString() },
            { key: "status", header: "Status", role: "headline", cell: (r) => <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge> },
            {
              key: "actions", role: "action",
              cell: (r) => r.status === "pending" && (
                <>
                  <button onClick={() => action.mutate({ id: r.id, status: "approved" })} disabled={action.isPending} className="btn-primary">
                    Approve
                  </button>
                  <button onClick={() => action.mutate({ id: r.id, status: "denied" })} disabled={action.isPending} className="btn-danger">
                    Deny
                  </button>
                </>
              ),
            },
          ]}
        />
      )}
      </div>
    </div>
  );
}
