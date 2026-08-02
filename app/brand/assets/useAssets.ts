"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import type { BrandAsset, BrandAssetKind, MarkFacets } from "@/lib/brand/assets";

// Shared JSON request helper — same pattern as app/brand/canon/useCanonEditor.ts's
// request(): throws on non-2xx, surfacing the API's { error } body when present.
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

// Multipart upload — deliberately does NOT set Content-Type so the browser
// attaches the multipart boundary itself (setting it manually breaks parsing).
async function uploadForm<T>(url: string, formData: FormData): Promise<T> {
  const res = await fetch(url, { method: "POST", body: formData });
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

export function useAssets(kind?: BrandAssetKind) {
  return useQuery({
    queryKey: queryKeys.brandAssets.list(kind),
    queryFn: () => requestJson<BrandAsset[]>(`/api/brand/assets${kind ? `?kind=${kind}` : ""}`),
  });
}

export function useUploadAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (formData: FormData) => uploadForm<BrandAsset>("/api/brand/assets", formData),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.brandAssets.all() }),
  });
}

export function useApproveAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      requestJson<{ ok: true }>(`/api/brand/assets/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "approve" }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.brandAssets.all() }),
  });
}

/**
 * Renames an asset, rewrites its alternative text, or re-files its mark facets.
 *
 * Shares the [id] PATCH route with approve/archive, distinguished by body
 * shape: an `action` approves or archives, any other field edits metadata.
 */
export function useUpdateAssetMeta() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...meta
    }: { id: string; title?: string; alt_text?: string } & MarkFacets) =>
      requestJson<{ ok: true }>(`/api/brand/assets/${id}`, {
        method: "PATCH",
        body: JSON.stringify(meta),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.brandAssets.all() }),
  });
}

export function useArchiveAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      requestJson<{ ok: true }>(`/api/brand/assets/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "archive" }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.brandAssets.all() }),
  });
}
