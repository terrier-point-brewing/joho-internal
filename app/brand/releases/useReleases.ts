"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import type { BrandRelease } from "@/lib/brand/releases";

// Shared JSON request helper — same pattern as useLabels.ts / useAssets.ts.
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

export function useReleases(status?: string) {
  return useQuery({
    queryKey: queryKeys.brandReleases.list(status),
    queryFn: () =>
      requestJson<BrandRelease[]>(`/api/brand/releases${status ? `?status=${status}` : ""}`),
  });
}

export function useCreateRelease() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string }) =>
      requestJson<BrandRelease>("/api/brand/releases", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.brandReleases.all() });
      // Creating a release also creates its label component row.
      qc.invalidateQueries({ queryKey: queryKeys.brandLabels.all() });
    },
  });
}

export function useUpdateRelease() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<BrandRelease> }) =>
      requestJson<{ ok: true }>(`/api/brand/releases/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.brandReleases.all() }),
  });
}

function useReleaseAction(action: "release" | "archive") {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      requestJson<{ ok: true }>(`/api/brand/releases/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ action }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.brandReleases.all() }),
  });
}
export const useMarkReleased = () => useReleaseAction("release");
export const useArchiveRelease = () => useReleaseAction("archive");
