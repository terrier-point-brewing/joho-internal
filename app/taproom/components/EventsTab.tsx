"use client";

import { useState } from "react";
import { formatCurrencyCents } from "@/lib/format";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TaproomEvent {
  id: string;
  event_name: string;
  event_start: string;
  event_end: string;
  event_host: string;
  notes: string | null;
  created_at: string;
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
  totals: { quantity: number; gross_cents: number; discount_cents: number; tax_cents: number; tip_cents: number };
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
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="rounded-md bg-surface border border-line px-3 py-2.5">
          <p className="text-xs text-muted uppercase tracking-wide mb-0.5">Net Sales</p>
          <p className="text-sm font-semibold text-accent">{fmtUsd(netSales)}</p>
        </div>
        <div className="rounded-md bg-surface border border-line px-3 py-2.5">
          <p className="text-xs text-muted uppercase tracking-wide mb-0.5">Sales Tax</p>
          <p className="text-sm font-semibold text-strong">{fmtUsd(totals.tax_cents)}</p>
        </div>
        <div className="rounded-md bg-surface border border-line px-3 py-2.5">
          <p className="text-xs text-muted uppercase tracking-wide mb-0.5">Tips</p>
          <p className="text-sm font-semibold text-strong">{fmtUsd(totals.tip_cents)}</p>
        </div>
        <div className="rounded-md bg-surface border border-line px-3 py-2.5">
          <p className="text-xs text-muted uppercase tracking-wide mb-0.5">Total Collected</p>
          <p className="text-sm font-semibold text-primary">{fmtUsd(netSales + totals.tax_cents + totals.tip_cents)}</p>
        </div>
      </div>

      {/* Variation breakdown table */}
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-line bg-surface/60">
              <th className="text-left px-3 py-2.5 text-muted font-medium">Variation</th>
              <th className="text-right px-3 py-2.5 text-muted font-medium">Qty</th>
              <th className="text-right px-3 py-2.5 text-muted font-medium">Gross</th>
              <th className="text-right px-3 py-2.5 text-muted font-medium">Discounts</th>
              <th className="text-right px-3 py-2.5 text-muted font-medium">Net</th>
              <th className="text-right px-3 py-2.5 text-muted font-medium">Tax</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/60">
            {rows.map((r) => (
              <tr key={r.variation_id} className="hover:bg-surface-mid/30 transition-colors">
                <td className="px-3 py-2.5 text-strong">{r.variation_name}</td>
                <td className="px-3 py-2.5 text-right text-body">{r.quantity}</td>
                <td className="px-3 py-2.5 text-right text-body">{fmtUsd(r.gross_cents)}</td>
                <td className="px-3 py-2.5 text-right text-muted">{r.discount_cents ? `(${fmtUsd(r.discount_cents)})` : "—"}</td>
                <td className="px-3 py-2.5 text-right text-strong font-medium">{fmtUsd(r.gross_cents - r.discount_cents)}</td>
                <td className="px-3 py-2.5 text-right text-muted">{fmtUsd(r.tax_cents)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-line-strong bg-surface/60 font-semibold">
              <td className="px-3 py-2.5 text-body">Total</td>
              <td className="px-3 py-2.5 text-right text-body">{totals.quantity}</td>
              <td className="px-3 py-2.5 text-right text-strong">{fmtUsd(totals.gross_cents)}</td>
              <td className="px-3 py-2.5 text-right text-secondary">{totals.discount_cents ? `(${fmtUsd(totals.discount_cents)})` : "—"}</td>
              <td className="px-3 py-2.5 text-right text-accent">{fmtUsd(netSales)}</td>
              <td className="px-3 py-2.5 text-right text-secondary">{fmtUsd(totals.tax_cents)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
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
  const [editingId,   setEditingId]   = useState<string | null>(null);
  const [expandedId,  setExpandedId]  = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [formError,   setFormError]   = useState<string | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: queryKeys.taproom.events() });

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

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/taproom/events/${id}`, { method: "DELETE" }).then((r) => {
        if (!r.ok && r.status !== 204) throw new Error("Failed to delete");
      }),
    onSuccess: () => { invalidate(); setDeleteConfirm(null); if (expandedId === deleteConfirm) setExpandedId(null); },
  });

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">Create and track events &mdash; pours are attributed from Square &ldquo;Event Pours&rdquo; items within each event&apos;s time window.</p>
        {!creating && (
          <button
            onClick={() => { setCreating(true); setEditingId(null); setFormError(null); }}
            className="btn-primary shrink-0 ml-4"
          >
            + New Event
          </button>
        )}
      </div>

      {error && <p className="text-xs text-danger">{error instanceof Error ? error.message : "Failed to load events"}</p>}

      {/* Create form */}
      {creating && (
        <div className="rounded-lg border border-accent-border/40 bg-accent-muted/10 p-4">
          <p className="text-xs font-semibold text-accent uppercase tracking-wide mb-3">New Event</p>
          {formError && <p className="text-xs text-danger mb-2">{formError}</p>}
          <EventForm
            initial={EMPTY_FORM}
            onSave={(form) => createMutation.mutate(form)}
            onCancel={() => { setCreating(false); setFormError(null); }}
            saving={createMutation.isPending}
          />
        </div>
      )}

      {/* Event list */}
      {isFetching && !events.length ? (
        <p className="text-xs text-faint py-6 text-center">Loading events…</p>
      ) : events.length === 0 && !creating ? (
        <p className="text-xs text-faint italic py-6 text-center">No events yet. Create one above.</p>
      ) : (
        <div className="space-y-2">
          {events.map((ev) => {
            const isEditing  = editingId  === ev.id;
            const isExpanded = expandedId === ev.id;

            return (
              <div key={ev.id} className="rounded-lg border border-line bg-surface/30">
                {/* Event header row */}
                <div className="flex items-start gap-3 px-4 py-3">
                  <button
                    className="flex-1 text-left min-w-0"
                    onClick={() => { if (!isEditing) setExpandedId(isExpanded ? null : ev.id); }}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-primary">{ev.event_name}</span>
                      <span className="text-xs text-muted border border-line-strong rounded px-1.5 py-0.5">
                        {ev.event_host}
                      </span>
                    </div>
                    <p className="text-xs text-muted mt-0.5">
                      {fmtDisplay(ev.event_start)} – {fmtDisplay(ev.event_end)}
                    </p>
                    {ev.notes && <p className="text-xs text-faint mt-0.5 truncate">{ev.notes}</p>}
                  </button>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => { setEditingId(isEditing ? null : ev.id); setFormError(null); }}
                      className="text-xs text-muted hover:text-body px-2 py-1 rounded hover:bg-surface-mid transition-colors"
                    >
                      {isEditing ? "Cancel" : "Edit"}
                    </button>
                    {deleteConfirm === ev.id ? (
                      <>
                        <button
                          onClick={() => deleteMutation.mutate(ev.id)}
                          className="text-xs text-danger hover:text-danger px-2 py-1 rounded hover:bg-surface-mid transition-colors"
                          disabled={deleteMutation.isPending}
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setDeleteConfirm(null)}
                          className="text-xs text-faint hover:text-secondary px-2 py-1"
                        >
                          ✕
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setDeleteConfirm(ev.id)}
                        className="text-xs text-disabled hover:text-danger px-2 py-1 rounded hover:bg-surface-mid transition-colors"
                      >
                        Delete
                      </button>
                    )}
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
