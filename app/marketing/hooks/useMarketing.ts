"use client";

/**
 * The calendar's client-side data access: one query and three mutations.
 *
 * Written locally rather than reached for, twice over:
 *
 *   * `fetchJson` lives in `@/app/production/hooks/queries` and the query keys
 *     in `@/lib/query-keys`. Marketing may import neither — the boundary guard
 *     (`scripts/check-marketing-boundary.mjs`) allows the shared infrastructure
 *     and nothing that belongs to another section. So the ~20 lines below are
 *     the seam being real, not duplication nobody noticed.
 *   * The keys are marketing's own for the same reason. They are a flat
 *     `["marketing", …]` family so one `invalidateQueries` after a write
 *     refreshes every window that is mounted.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { MarketingEntry } from "@/lib/marketing/entries";
import type { Media } from "@/lib/marketing/plugins/types";

export const marketingKeys = {
  all: () => ["marketing"] as const,
  entries: (fromIso: string, toIso: string) => ["marketing", "entries", fromIso, toIso] as const,
};

/**
 * Throws with the API's own sentence when there is one.
 *
 * Every refusal in marketing is written as something a person can read — "A
 * reel needs a video.", "Nothing is connected for …" — so swallowing the body
 * and reporting a status code would throw away the only useful part.
 */
async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* non-JSON body — keep the status message */
    }
    throw new Error(message);
  }
  return res.json();
}

/** What a person filled in on Compose, in the shape the route parses. */
export interface CreateEntryBody {
  kind: string;
  startsAt: string;
  caption?: string | null;
  mediaIds?: string[];
  channels?: string[];
  postNow?: boolean;
}

/**
 * Every entry starting in `[fromIso, toIso)`, with its media in order and its
 * deliveries attached. One request draws the whole grid.
 */
export function useEntriesQuery(fromIso: string, toIso: string) {
  return useQuery({
    queryKey: marketingKeys.entries(fromIso, toIso),
    queryFn: async () =>
      jsonOrThrow<MarketingEntry[]>(
        await fetch(`/api/marketing/entries?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`),
      ),
  });
}

export function useCreateEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateEntryBody) =>
      jsonOrThrow<MarketingEntry>(
        await fetch("/api/marketing/entries", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: marketingKeys.all() }),
  });
}

/**
 * Upload one creative. Deliberately does NOT set Content-Type: the browser has
 * to attach the multipart boundary itself.
 */
export function useUploadMedia() {
  return useMutation({
    mutationFn: async (form: FormData) =>
      jsonOrThrow<Media>(await fetch("/api/marketing/media", { method: "POST", body: form })),
  });
}

/** Put one failed delivery back on the queue. A person's decision, always. */
export function useRetryDelivery() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (deliveryId: string) =>
      jsonOrThrow<{ ok: true }>(
        await fetch(`/api/marketing/deliveries/${deliveryId}/retry`, { method: "POST" }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: marketingKeys.all() }),
  });
}
