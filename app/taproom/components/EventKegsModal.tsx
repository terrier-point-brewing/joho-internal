"use client";

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import { Modal, Field } from "@/app/components/ui/Modal";
import Banner from "@/app/components/ui/Banner";
import { SearchCombobox, type SearchComboboxItem } from "@/components/ui/SearchCombobox";
import type { EventKegLine, EventKegStock } from "@/app/api/taproom/events/[id]/kegs/route";

export interface EventKegsData {
  closed_at: string | null;
  event_end: string;
  lines: EventKegLine[];
  stock: EventKegStock[];
}

export function useEventKegsQuery(eventId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.taproom.eventKegs(eventId),
    queryFn:  () => fetchJson<EventKegsData>(`/api/taproom/events/${eventId}/kegs`),
    enabled,
  });
}

interface DraftLine { key: number; recipeId: string; variationId: string; quantity: string; notes: string }

let nextKey = 1;
const blankLine = (): DraftLine => ({ key: nextKey++, recipeId: "", variationId: "", quantity: "1", notes: "" });

/**
 * Close-out: the kegs an event tapped, shipped ad-hoc to the taproom from here
 * instead of from Production's Export Bay. One line per beer; whole kegs only.
 * Opens again after close-out as "Add a keg" for one that was forgotten.
 */
export default function EventKegsModal({ eventId, eventName, onClose }: { eventId: string; eventName: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { data, isLoading, error: loadError } = useEventKegsQuery(eventId);
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);
  const [error, setError] = useState<string | null>(null);
  // Sampled once on open; the modal is short-lived and a tick mid-form must not flip the button.
  const [now] = useState(() => Date.now());

  const stock = useMemo(() => data?.stock ?? [], [data]);
  const recipeItems = useMemo<SearchComboboxItem[]>(() => {
    const byRecipe = new Map<string, { name: string; onHand: number }>();
    for (const s of stock) {
      const r = byRecipe.get(s.recipe_id) ?? { name: s.recipe_name, onHand: 0 };
      r.onHand += s.quantity_on_hand;
      byRecipe.set(s.recipe_id, r);
    }
    return [...byRecipe.entries()]
      .map(([id, r]) => ({ id, label: r.name, hint: `${r.onHand} keg${r.onHand === 1 ? "" : "s"}` }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [stock]);

  const alreadyClosed = Boolean(data?.closed_at);
  const notEnded = data ? new Date(data.event_end).getTime() > now : false;

  const update = (key: number, patch: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/taproom/events/${eventId}/kegs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: lines.map((l) => ({ recipe_id: l.recipeId, variation_id: l.variationId, quantity: parseInt(l.quantity, 10), notes: l.notes || null })),
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to record kegs");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.taproom.events() });
      qc.invalidateQueries({ queryKey: queryKeys.taproom.eventKegs(eventId) });
      onClose();
    },
    onError: (e: Error) => {
      setError(e.message);
      // A partial write is real beer that left; the list under the event is the truth now.
      qc.invalidateQueries({ queryKey: queryKeys.taproom.eventKegs(eventId) });
    },
  });

  const complete = lines.length > 0 && lines.every((l) => l.recipeId && l.variationId && parseInt(l.quantity, 10) > 0);

  return (
    <Modal title={alreadyClosed ? `Add a keg · ${eventName}` : `Close out · ${eventName}`} onClose={onClose} wide>
      <div className="space-y-3">
        {!alreadyClosed && (
          <Banner tone="info">
            <p>Pick each beer poured at the event, its keg size, and how many kegs were tapped. A partly used keg counts as one.</p>
            <p className="mt-1">This takes the kegs out of cold storage and into the excise record, the same as Production&rsquo;s Ad-Hoc Export.</p>
          </Banner>
        )}
        {notEnded && <Banner tone="danger"><p>This event has not ended yet. Record its kegs after the end time.</p></Banner>}
        {loadError && <p className="text-xs text-danger">{loadError instanceof Error ? loadError.message : "Failed to load"}</p>}
        {isLoading && <p className="text-xs text-faint py-4 text-center">Loading kegs in stock…</p>}

        {data && (
          <div className="space-y-3">
            {lines.map((l, i) => {
              const sizes = stock.filter((s) => s.recipe_id === l.recipeId);
              const chosen = sizes.find((s) => s.variation_id === l.variationId);
              return (
                <div key={l.key} className="rounded-lg border border-line bg-surface/40 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted uppercase tracking-wide">Beer {i + 1}</p>
                    {lines.length > 1 && (
                      <button type="button" className="btn-secondary btn-xxs" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>Remove</button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-[2fr_1.5fr_0.7fr] gap-2">
                    <Field label="Beer" required>
                      <SearchCombobox
                        value={l.recipeId}
                        onChange={(id) => {
                          const first = stock.find((s) => s.recipe_id === id);
                          update(l.key, { recipeId: id, variationId: first?.variation_id ?? "" });
                        }}
                        items={recipeItems}
                        placeholder="Search beers in stock…"
                        emptyLabel="No kegs of that beer in cold storage"
                        clearable={false}
                        required
                      />
                    </Field>
                    <Field label="Keg size" required>
                      <select className="inp w-full" value={l.variationId} onChange={(e) => update(l.key, { variationId: e.target.value })} disabled={!l.recipeId}>
                        {sizes.map((s) => (
                          <option key={s.variation_id} value={s.variation_id}>{s.variation_name} ({s.quantity_on_hand} available)</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Kegs" required>
                      <input
                        type="number" inputMode="numeric" min="1" step="1" className="inp w-full" value={l.quantity}
                        max={chosen?.quantity_on_hand}
                        onChange={(e) => update(l.key, { quantity: e.target.value })}
                      />
                    </Field>
                  </div>
                  <Field label="Note" hint="optional">
                    <input className="inp w-full" value={l.notes} onChange={(e) => update(l.key, { notes: e.target.value })} placeholder="e.g. half a keg left, back in the walk-in" />
                  </Field>
                </div>
              );
            })}
            <button type="button" className="btn-secondary" onClick={() => setLines((ls) => [...ls, blankLine()])}>+ Add another beer</button>
          </div>
        )}

        {error && <p className="text-xs text-danger">{error}</p>}

        <div className="flex justify-end gap-2 pt-2 border-t border-line mt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button
            type="button"
            className="btn-primary"
            disabled={!data || notEnded || !complete || mutation.isPending}
            onClick={() => { setError(null); mutation.mutate(); }}
          >
            {mutation.isPending ? "Recording…" : alreadyClosed ? "Add kegs" : "Record kegs & close out"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
