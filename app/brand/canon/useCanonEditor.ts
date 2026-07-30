"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import type { BrandCanon } from "@/lib/brand/canon.types";

import type { ChangeEntry } from "@/lib/brand/diffCanon";
import type { GuideSectionKey } from "@/lib/brand/guideIntros";

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

// NOTE: there is deliberately no whole-document save hook. The editor saves per
// section (usePatchSection below). The PUT /api/brand/canon/draft route and
// lib/brand/canonWorkflow.saveDraft remain as a server-side escape hatch, but
// nothing in the UI sends a full document any more.

/**
 * Saves ONE subtab's slice of the draft. The path autosave uses.
 *
 * Deliberately does NOT invalidate the draft query on success. An invalidate
 * triggers a refetch, and a refetch landing mid-edit is exactly the race the
 * re-seed guard in CanonEditor exists to defend against — autosave fires often
 * enough to hit it constantly. The server's response carries no new
 * information (we know what we just wrote), so the cache is updated in place
 * and no refetch happens at all.
 */
export function usePatchSection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      section,
      patch,
    }: {
      section: GuideSectionKey;
      patch: Partial<BrandCanon>;
    }) =>
      request<{ ok: true }>("/api/brand/canon/draft", {
        method: "PATCH",
        body: JSON.stringify({ section, patch }),
      }),
    onSuccess: (_data, { patch }) => {
      qc.setQueryData<BrandCanon>(queryKeys.brandCanon.draft(), (prev) =>
        prev
          ? {
              ...prev,
              ...patch,
              ...(patch.guideIntros
                ? { guideIntros: { ...prev.guideIntros, ...patch.guideIntros } }
                : {}),
            }
          : prev,
      );
    },
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
