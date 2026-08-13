"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BrandTemplate } from "@/lib/brand/templates";
import type { BrandSeason } from "@/lib/brand/seasons";

const TEMPLATES = ["brand", "templates"] as const;
const SEASONS = ["brand", "seasons"] as const;

/** Surfaces the API's own message — validation failures name the bad slot. */
async function send(url: string, init: RequestInit) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? "Request failed");
  return body;
}

export function useTemplates() {
  return useQuery<BrandTemplate[]>({
    queryKey: TEMPLATES,
    queryFn: async () => {
      const res = await fetch("/api/brand/templates");
      if (!res.ok) throw new Error("Failed to load templates");
      return res.json();
    },
  });
}

export function useCreateTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { key: string; name: string; medium: string }) =>
      send("/api/brand/templates", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: TEMPLATES }),
  });
}

export function useTemplateAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; action: string }) =>
      send(`/api/brand/templates/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: TEMPLATES }),
  });
}

export function useSeasons() {
  return useQuery<BrandSeason[]>({
    queryKey: SEASONS,
    queryFn: async () => {
      const res = await fetch("/api/brand/seasons");
      if (!res.ok) throw new Error("Failed to load seasons");
      return res.json();
    },
  });
}

export function useCreateSeason() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; background_hex?: string }) =>
      send("/api/brand/seasons", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: SEASONS }),
  });
}

/**
 * Field edits on a season. `status` is not among them — activation is its own
 * gated action, and the server drops a status out of a field patch anyway.
 */
export function useUpdateSeason() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & Partial<Omit<BrandSeason, "id" | "status">>) =>
      send(`/api/brand/seasons/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    // Editing the ACTIVE season changes what every motif slot resolves to, so
    // templates are invalidated alongside seasons here too.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SEASONS });
      qc.invalidateQueries({ queryKey: TEMPLATES });
    },
  });
}

export function useActivateSeason() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      send(`/api/brand/seasons/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "activate" }),
      }),
    // Activating changes what every motif slot resolves to, so templates are
    // invalidated alongside seasons.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SEASONS });
      qc.invalidateQueries({ queryKey: TEMPLATES });
    },
  });
}
