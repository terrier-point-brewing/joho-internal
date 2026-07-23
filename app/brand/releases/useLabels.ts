"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import type { BrandLabel } from "@/lib/brand/labels";

// Shared JSON request helper — same pattern as app/brand/assets/useAssets.ts.
async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* non-JSON error body — keep the status message */
    }
    throw new Error(message);
  }
  return res.json();
}

export function useLabels(status?: string) {
  return useQuery({
    queryKey: queryKeys.brandLabels.list(status),
    queryFn: () =>
      requestJson<BrandLabel[]>(`/api/brand/labels${status ? `?status=${status}` : ""}`),
  });
}

export function useCreateLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; subtitle?: string; motif_family?: string }) =>
      requestJson<BrandLabel>("/api/brand/labels", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.brandLabels.all() }),
  });
}

export function useUpdateLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<BrandLabel> }) =>
      requestJson<BrandLabel>(`/api/brand/labels/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.brandLabels.all() }),
  });
}

function useLabelAction(action: "approve" | "archive") {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      requestJson<BrandLabel>(`/api/brand/labels/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ action }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.brandLabels.all() }),
  });
}
export const useApproveLabel = () => useLabelAction("approve");
export const useArchiveLabel = () => useLabelAction("archive");
