"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import type { BrandCanon } from "@/lib/brand/canon.types";

import type { ChangeEntry } from "@/lib/brand/diffCanon";

export interface VersionRow {
  id: string;
  version_label: string;
  status: "published" | "archived";
  published_at: string | null;
  changelog: string | null;
  /** Null for versions published before migration 20260902. */
  change_entries: ChangeEntry[] | null;
}

// Shared fetch helper: throws on non-2xx, surfacing the API's { error } body
// when present (same shape as app/production/hooks/queries.ts's fetchJson,
// duplicated here since it also needs to send bodies for PUT/POST).
async function request<T>(url: string, init?: RequestInit): Promise<T> {
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

export function useDraft() {
  return useQuery({
    queryKey: queryKeys.brandCanon.draft(),
    queryFn: () => request<BrandCanon>("/api/brand/canon/draft"),
  });
}

export function useSaveDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (document: BrandCanon) =>
      request<{ ok: true }>("/api/brand/canon/draft", {
        method: "PUT",
        body: JSON.stringify(document),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.brandCanon.draft() }),
  });
}

export function usePublish() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (opts: { versionLabel?: string; changelog?: string }) =>
      request<{ versionLabel: string }>("/api/brand/canon/publish", {
        method: "POST",
        body: JSON.stringify(opts),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.brandCanon.draft() });
      qc.invalidateQueries({ queryKey: queryKeys.brandCanon.versions() });
    },
  });
}

export function useVersions() {
  return useQuery({
    queryKey: queryKeys.brandCanon.versions(),
    queryFn: () => request<VersionRow[]>("/api/brand/canon/versions"),
  });
}
