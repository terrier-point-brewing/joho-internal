"use client";

import ListTable from "@/app/components/ui/ListTable";
import { useState } from "react";
import { formatCurrencyCents } from "@/lib/format";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import Badge from "@/app/components/ui/Badge";
import EventsHelp from "./EventsHelp";
import EventKegsModal, { useEventKegsQuery } from "./EventKegsModal";
import EventTipsPanel from "./EventTipsPanel";
import UnallocatedPoursPanel from "./UnallocatedPoursPanel";
import { stretchedWindow, type OrphanCluster } from "@/lib/taproom/unallocatedEventPours";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TaproomEvent {
  id: string;
  event_name: string;
  event_start: string;
  event_end: string;
  event_host: string;
  notes: string | null;
  created_at: string;
  /** Set once the event's kegs were recorded (shipped to the taproom from this tab). */
  closed_at: string | null;
}

interface PourRow {
  variation_id:   string;
  variation_name: string;
  quantity:       number;
  gross_cents:    number;
  discount_cents: number;
  tax_cents:      number;
}

interface PourData {
  event:  TaproomEvent;
  rows:   PourRow[];
  totals: { quantity: number; gross_cents: number; discount_cents: number; tax_cents: number; tip_cents: number; card_tip_cents: number; cash_tip_cents: number };
}

interface EventFormState {
  event_name:  string;
  event_start: string;
  event_end:   string;
  event_host:  string;
  notes:       string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtUsd(cents: number) {
  return formatCurrencyCents(cents);
}

function fmtDatetimeLocal(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function fmtDisplay(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

/** A window on one day reads "Nov 13, 2026 · 5:00 PM – 9:00 PM": one line on a phone. */
function fmtRange(startIso: string, endIso: string) {
  const a = new Date(startIso), b = new Date(endIso);
  if (a.toDateString() !== b.toDateString()) return `${fmtDisplay(startIso)} – ${fmtDisplay(endIso)}`;
  const day = a.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const time = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${day} · ${time(a)} – ${time(b)}`;
}

const EMPTY_FORM: EventFormState = {
  event_name: "", event_start: "", event_end: "", event_host: "", notes: "",
};

// ─── EventForm ────────────────────────────────────────────────────────────────

function EventForm({
  initial,
  onSave,
  onCancel,
  saving,
}: {
  initial: EventFormState;
  onSave:  (form: EventFormState) => void;
  onCancel: () => void;
  saving:  boolean;
}) {
  const [form, setForm] = useState<EventFormState>(initial);
  const set = (k: keyof EventFormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const valid = form.event_name.trim() && form.event_start && form.event_end && form.event_host.trim();

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-muted uppercase tracking-wide mb-1">Event Name *</label>
          <input className="inp w-full text-sm" value={form.event_name} onChange={set("event_name")} placeholder="e.g. Trivia Night" />
        </div>
        <div>
          <label className="block text-xs text-muted uppercase tracking-wide mb-1">Event Host *</label>
          <input className="inp w-full text-sm" value={form.event_host} onChange={set("event_host")} placeholder="e.g. Jane Smith" />
        </div>
        <div>
          <label className="block text-xs text-muted uppercase tracking-wide mb-1">Start *</label>
          <input type="datetime-local" className="inp w-full text-sm" value={form.event_start} onChange={set("event_start")} />
        </div>
        <div>
          <label className="block text-xs text-muted uppercase tracking-wide mb-1">End *</label>
          <input type="datetime-local" className="inp w-full text-sm" value={form.event_end} onChange={set("event_end")} />
        </div>
      </div>
      <div>
        <label className="block text-xs text-muted uppercase tracking-wide mb-1">Notes</label>
        <textarea className="inp w-full text-sm resize-none" rows={2} value={form.notes} onChange={set("notes")} placeholder="Optional notes…" />
      </div>
      <div className="flex gap-2 justify-end pt-1">
        <button type="button" onClick={onCancel} className="btn-secondary" disabled={saving}>Cancel</button>
        <button
          type="button"
          onClick={() => onSave(form)}
          disabled={!valid || saving}
          className="btn-primary"
        >
          {saving ? "Saving…" : "Save Event"}
        </button>
      </div>
    </div>
  );
}

// ─── EventCardStats ───────────────────────────────────────────────────────────

/**
 * Net sales and tips on the collapsed card, so every event can be compared
 * without opening each one. Same query as the pour table, so expanding the
 * event costs nothing extra.
 */
function EventCardStats({ eventId }: { eventId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.taproom.eventPours(eventId),
    queryFn:  () => fetchJson<PourData>(`/api/taproom/events/${eventId}/pours`),
  });

  if (isLoading) return <p className="text-xs text-faint mt-1">Loading sales…</p>;
  if (error || !data) return null;

  const { totals } = data;
  const net = totals.gross_cents - totals.discount_cents;
  const stat = (label: string, value: number, strong = false) => (
    <span className="whitespace-nowrap">
      <span className="text-muted">{label} </span>
      <span className={strong ? "font-semibold text-accent" : "font-medium text-strong"}>{fmtUsd(value)}</span>
    </span>
  );

  return (
    <p className="text-xs mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
      {stat("Net sales", net, true)}
      {stat("Card tips", totals.card_tip_cents)}
      {stat("Cash tips", totals.cash_tip_cents)}
      <span className="whitespace-nowrap"><span className="text-muted">Pours </span><span className="font-medium text-strong">{totals.quantity}</span></span>
    </p>
  );
}

// ─── PourTable ────────────────────────────────────────────────────────────────

function PourTable({ eventId }: { eventId: string }) {
  const { data, isFetching, error } = useQuery({
    queryKey: queryKeys.taproom.eventPours(eventId),
    queryFn:  () => fetchJson<PourData>(`/api/taproom/events/${eventId}/pours`),
  });

  if (isFetching) return <p className="text-xs text-faint py-4 text-center">Loading pours…</p>;
  if (error) return <p className="text-xs text-danger py-2">{error instanceof Error ? error.message : "Failed to load"}</p>;
  if (!data || data.rows.length === 0) return (
    <p className="text-xs text-faint italic py-4 text-center">No Event Pours found in this time window.</p>
  );

  const { rows, totals } = data;
  const netSales = totals.gross_cents - totals.discount_cents;

  return (
    <div className="space-y-3">
      {/* Summary stat strip */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <div className="max-sm:col-span-2 rounded-md bg-surface border border-line px-3 py-2.5">
          <p className="text-xs text-muted uppercase tracking-wide mb-0.5">Net Sales</p>
          <p className="text-sm font-semibold text-accent">{fmtUsd(netSales)}</p>
        </div>
        <div className="rounded-md bg-surface border border-line px-3 py-2.5">
          <p className="text-xs text-muted uppercase tracking-wide mb-0.5">Sales Tax</p>
          <p className="text-sm font-semibold text-strong">{fmtUsd(totals.tax_cents)}</p>
        </div>
        <div className="rounded-md bg-surface border border-line px-3 py-2.5">
          <p className="text-xs text-muted uppercase tracking-wide mb-0.5">Card Tips</p>
          <p className="text-sm font-semibold text-strong">{fmtUsd(totals.card_tip_cents)}</p>
        </div>
        <div className="rounded-md bg-surface border border-line px-3 py-2.5">
          <p className="text-xs text-muted uppercase tracking-wide mb-0.5">Cash Tips</p>
          <p className="text-sm font-semibold text-strong">{fmtUsd(totals.cash_tip_cents)}</p>
        </div>
        <div className="rounded-md bg-surface border border-line px-3 py-2.5">
          <p className="text-xs text-muted uppercase tracking-wide mb-0.5">Total Collected</p>
          <p className="text-sm font-semibold text-primary">{fmtUsd(netSales + totals.tax_cents + totals.tip_cents)}</p>
        </div>
      </div>

      {/* Variation breakdown table */}
      {/* The totals ride as a last row so they stay under their columns on a
          desktop and fold like every other row on a phone. */}
      <ListTable<(typeof rows)[number] & { total?: boolean }>
        className="text-xs"
        dense
        zebra={false}
        rows={[...rows, { ...rows[0], ...totals, variation_id: "__total", variation_name: "Total", total: true }]}
        rowKey={(r) => r.variation_id}
        rowClassName={(r) => (r.total ? "bg-surface/60 font-semibold border-t border-line-strong" : "")}
        cols={[
          { key: "item", header: "Item", role: "label", className: "!font-normal !text-strong text-xs", cell: (r) => r.variation_name },
          { key: "qty", header: "Qty", align: "right", foldLabel: "Qty", className: "text-body text-xs tabular-nums", cell: (r) => r.quantity },
          { key: "gross", header: "Gross", align: "right", foldLabel: "Gross", className: "text-body text-xs tabular-nums", cell: (r) => fmtUsd(r.gross_cents) },
          { key: "disc", header: "Discounts", align: "right", foldLabel: "Discounts", className: "text-muted text-xs tabular-nums", cell: (r) => (r.discount_cents ? `(${fmtUsd(r.discount_cents)})` : null) },
          { key: "net", header: "Net", role: "headline", align: "right", className: "text-xs tabular-nums font-medium", cell: (r) => <span className={r.total ? "text-accent" : "text-strong"}>{fmtUsd(r.gross_cents - r.discount_cents)}</span> },
          { key: "tax", header: "Tax", align: "right", foldLabel: "Tax", className: "text-muted text-xs tabular-nums", cell: (r) => fmtUsd(r.tax_cents) },
        ]}
      />
    </div>
  );
}

// ─── Tips ─────────────────────────────────────────────────────────────────────

/** Reads the event's tip totals from the pours query (already cached by the
 *  table above) and hands them to the payout panel. */
function EventTipsSection({ eventId, ended }: { eventId: string; ended: boolean }) {
  const { data } = useQuery({
    queryKey: queryKeys.taproom.eventPours(eventId),
    queryFn:  () => fetchJson<PourData>(`/api/taproom/events/${eventId}/pours`),
  });
  const t = data?.totals;
  return (
    <EventTipsPanel
      eventId={eventId}
      ended={ended}
      collectedCents={(t?.card_tip_cents ?? 0) + (t?.cash_tip_cents ?? 0)}
      cardCents={t?.card_tip_cents ?? 0}
      cashCents={t?.cash_tip_cents ?? 0}
    />
  );
}

// ─── KegsUsed ─────────────────────────────────────────────────────────────────

function KegsUsed({ eventId, closed, ended, onRecord }: { eventId: string; closed: boolean; ended: boolean; onRecord: () => void }) {
  const { data, isLoading, error } = useEventKegsQuery(eventId);
  const lines = data?.lines ?? [];

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted uppercase tracking-wide font-medium">Kegs used</p>
        {ended && (
          <button type="button" onClick={onRecord} className={closed ? "btn-secondary btn-xxs" : "btn-primary btn-xxs"}>
            {closed ? "Add a keg" : "Close out"}
          </button>
        )}
      </div>
      {isLoading ? (
        <p className="text-xs text-faint py-2 text-center">Loading…</p>
      ) : error ? (
        <p className="text-xs text-danger">{error instanceof Error ? error.message : "Failed to load"}</p>
      ) : lines.length === 0 ? (
        <p className="text-xs text-faint italic py-2">
          {ended ? "No kegs recorded yet. Press Close out to record the kegs this event tapped." : "Kegs are recorded after the event ends."}
        </p>
      ) : (
        <ListTable<(typeof lines)[number]>
          className="text-xs"
          dense
          zebra={false}
          rows={lines}
          rowKey={(l) => l.source_ref}
          cols={[
            { key: "beer", header: "Beer", role: "label", className: "!font-normal !text-strong text-xs", cell: (l) => l.recipe_name },
            { key: "keg", header: "Keg", className: "text-body text-xs", cell: (l) => l.variation_name },
            { key: "kegs", header: "Kegs", role: "headline", align: "right", className: "text-body text-xs tabular-nums", cell: (l) => l.quantity },
            { key: "recorded", header: "Recorded", className: "text-muted text-xs whitespace-nowrap", cell: (l) => fmtDisplay(l.shipped_at) },
            { key: "note", header: "Note", foldBlock: true, className: "text-muted text-xs", cell: (l) => l.notes },
          ]}
        />
      )}
      {closed && (
        <p className="text-xs text-faint">A keg recorded by mistake is reversed in Production, not here.</p>
      )}
    </div>
  );
}

// ─── Main tab ─────────────────────────────────────────────────────────────────

export default function EventsTab() {
  const qc = useQueryClient();

  const { data: events = [], isFetching, error } = useQuery({
    queryKey: queryKeys.taproom.events(),
    queryFn:  () => fetchJson<TaproomEvent[]>("/api/taproom/events"),
  });

  const [creating,    setCreating]    = useState(false);
  // Prefill for the create form when it was opened from an unallocated-pours group.
  const [createInitial, setCreateInitial] = useState<EventFormState>(EMPTY_FORM);
  const [editingId,   setEditingId]   = useState<string | null>(null);
  const [expandedId,  setExpandedId]  = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [formError,   setFormError]   = useState<string | null>(null);
  const [showHelp,    setShowHelp]    = useState(false);
  const [kegsFor,     setKegsFor]     = useState<TaproomEvent | null>(null);
  // "Ended" is judged against the moment the tab mounted; a reload re-judges it.
  const [now] = useState(() => Date.now());

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: queryKeys.taproom.events() });
    // Any window change can claim or release pours, so the orphan scan is stale too.
    qc.invalidateQueries({ queryKey: ["taproom", "event-unallocated"] });
    qc.invalidateQueries({ queryKey: ["taproom", "event-pours"] });
  };

  const createMutation = useMutation({
    mutationFn: (form: EventFormState) =>
      fetch("/api/taproom/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          event_start: new Date(form.event_start).toISOString(),
          event_end:   new Date(form.event_end).toISOString(),
        }),
      }).then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? "Failed to create");
        return r.json();
      }),
    onSuccess: (newEvent: TaproomEvent) => {
      invalidate();
      setCreating(false);
      setExpandedId(newEvent.id);
      setFormError(null);
    },
    onError: (e: Error) => setFormError(e.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, form }: { id: string; form: EventFormState }) =>
      fetch(`/api/taproom/events/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          event_start: new Date(form.event_start).toISOString(),
          event_end:   new Date(form.event_end).toISOString(),
        }),
      }).then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? "Failed to update");
        return r.json();
      }),
    onSuccess: () => { invalidate(); setEditingId(null); setFormError(null); },
    onError: (e: Error) => setFormError(e.message),
  });

  // "Add to <event>" on an unallocated group: widen that event's window so the
  // pours route counts the pours. Same PUT as Edit, with the rest unchanged.
  const stretchMutation = useMutation({
    mutationFn: async (c: OrphanCluster) => {
      const ev = events.find((e) => e.id === c.nearest_event?.id);
      if (!ev) throw new Error("That event is no longer listed. Reload and try again.");
      const win = stretchedWindow(ev, c);
      const r = await fetch(`/api/taproom/events/${ev.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_name: ev.event_name, event_host: ev.event_host, notes: ev.notes ?? "", ...win }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? "Failed to update");
      return r.json() as Promise<TaproomEvent>;
    },
    onSuccess: (ev) => { invalidate(); setExpandedId(ev.id); setFormError(null); },
    onError: (e: Error) => setFormError(e.message),
  });

  const openCreateFromCluster = (c: OrphanCluster) => {
    const pad = 15 * 60 * 1000;
    setCreateInitial({
      ...EMPTY_FORM,
      event_name:  "",
      event_start: fmtDatetimeLocal(new Date(new Date(c.first_closed_at).getTime() - pad).toISOString()),
      event_end:   fmtDatetimeLocal(new Date(new Date(c.last_closed_at).getTime() + pad).toISOString()),
    });
    setCreating(true); setEditingId(null); setFormError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/taproom/events/${id}`, { method: "DELETE" }).then(async (r) => {
        if (!r.ok && r.status !== 204) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed to delete");
      }),
    onSuccess: () => { invalidate(); setDeleteConfirm(null); setFormError(null); if (expandedId === deleteConfirm) setExpandedId(null); },
    onError: (e: Error) => { setFormError(e.message); setDeleteConfirm(null); },
  });

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-end gap-2">
        <button onClick={() => setShowHelp(true)} className="btn-secondary">
          How to use
        </button>
        {!creating && (
          <button
            onClick={() => { setCreateInitial(EMPTY_FORM); setCreating(true); setEditingId(null); setFormError(null); }}
            className="btn-primary shrink-0"
          >
            + New Event
          </button>
        )}
      </div>

      {showHelp && <EventsHelp onClose={() => setShowHelp(false)} />}
      {kegsFor && <EventKegsModal eventId={kegsFor.id} eventName={kegsFor.event_name} onClose={() => setKegsFor(null)} />}

      {error && <p className="text-xs text-danger">{error instanceof Error ? error.message : "Failed to load events"}</p>}
      {formError && !creating && !editingId && <p className="text-xs text-danger">{formError}</p>}

      {/* Create form */}
      {creating && (
        <div className="rounded-lg border border-accent-border/40 bg-accent-muted/10 p-4">
          <p className="text-xs font-semibold text-accent uppercase tracking-wide mb-3">New Event</p>
          {formError && <p className="text-xs text-danger mb-2">{formError}</p>}
          <EventForm
            key={`${createInitial.event_start}|${createInitial.event_end}`}
            initial={createInitial}
            onSave={(form) => createMutation.mutate(form)}
            onCancel={() => { setCreating(false); setFormError(null); }}
            saving={createMutation.isPending}
          />
        </div>
      )}

      {/* Event Pours no event window covers */}
      <UnallocatedPoursPanel
        onCreateFromCluster={openCreateFromCluster}
        onStretchEvent={(c) => stretchMutation.mutate(c)}
        stretching={stretchMutation.isPending}
      />

      {/* Event list */}
      {isFetching && !events.length ? (
        <p className="text-xs text-faint py-6 text-center">Loading events…</p>
      ) : events.length === 0 && !creating ? (
        <p className="text-xs text-faint italic py-6 text-center">
          No events yet. Create one above — pours rung as Square &ldquo;Event Pours&rdquo; during its time window count toward it.
        </p>
      ) : (
        <div className="space-y-2">
          {events.map((ev) => {
            const isEditing  = editingId  === ev.id;
            const isExpanded = expandedId === ev.id;
            const ended      = new Date(ev.event_end).getTime() <= now;
            const closed     = Boolean(ev.closed_at);

            return (
              <div key={ev.id} className="rounded-lg border border-line bg-surface/30">
                {/* Event header row */}
                {/* On a phone the actions take their own line under the name
                    instead of squeezing it (§7 C). */}
                <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3">
                  <button
                    className="flex-1 text-left min-w-0 max-sm:basis-full"
                    onClick={() => { if (!isEditing) setExpandedId(isExpanded ? null : ev.id); }}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-primary">{ev.event_name}</span>
                      <Badge tone="neutral">{ev.event_host}</Badge>
                      {closed ? (
                        <Badge tone="success" title={`Kegs recorded ${fmtDisplay(ev.closed_at!)}`}>Closed out</Badge>
                      ) : ended ? (
                        <Badge tone="neutral" title="The kegs this event tapped have not been recorded yet">Kegs not recorded</Badge>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted mt-0.5">
                      {fmtRange(ev.event_start, ev.event_end)}
                    </p>
                    {ev.notes && <p className="text-xs text-faint mt-0.5 truncate">{ev.notes}</p>}
                    <EventCardStats eventId={ev.id} />
                  </button>

                  <div className="flex flex-wrap items-center gap-1.5 sm:gap-1 shrink-0">
                    {ended && !closed && !isEditing && (
                      <button onClick={() => setKegsFor(ev)} className="btn-primary btn-xxs">
                        Close out
                      </button>
                    )}
                    <button
                      onClick={() => { setEditingId(isEditing ? null : ev.id); setFormError(null); }}
                      className="btn-secondary btn-xxs"
                    >
                      {isEditing ? "Cancel" : "Edit"}
                    </button>
                    {deleteConfirm === ev.id ? (
                      <>
                        <button
                          onClick={() => deleteMutation.mutate(ev.id)}
                          className="btn-danger btn-xxs"
                          disabled={deleteMutation.isPending}
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setDeleteConfirm(null)}
                          className="btn-secondary btn-xxs"
                        >
                          ✕
                        </button>
                      </>
                    ) : !closed ? (
                      <button
                        onClick={() => setDeleteConfirm(ev.id)}
                        className="btn-danger btn-xxs"
                      >
                        Delete
                      </button>
                    ) : null}
                  </div>
                </div>

                {/* Edit form */}
                {isEditing && (
                  <div className="border-t border-line px-4 py-3">
                    {formError && <p className="text-xs text-danger mb-2">{formError}</p>}
                    <EventForm
                      initial={{
                        event_name:  ev.event_name,
                        event_start: fmtDatetimeLocal(ev.event_start),
                        event_end:   fmtDatetimeLocal(ev.event_end),
                        event_host:  ev.event_host,
                        notes:       ev.notes ?? "",
                      }}
                      onSave={(form) => updateMutation.mutate({ id: ev.id, form })}
                      onCancel={() => { setEditingId(null); setFormError(null); }}
                      saving={updateMutation.isPending}
                    />
                  </div>
                )}

                {/* Pours detail */}
                {isExpanded && !isEditing && (
                  <div className="border-t border-line px-4 py-3">
                    <p className="text-xs text-muted uppercase tracking-wide font-medium mb-3">Pour Sales by Variation</p>
                    <PourTable eventId={ev.id} />
                    <div className="mt-4 pt-3 border-t border-line">
                      <KegsUsed eventId={ev.id} closed={closed} ended={ended} onRecord={() => setKegsFor(ev)} />
                    </div>
                    <div className="mt-4 pt-3 border-t border-line">
                      <EventTipsSection eventId={ev.id} ended={ended} />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
