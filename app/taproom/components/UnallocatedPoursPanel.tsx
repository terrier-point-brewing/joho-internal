"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import { formatCurrencyCents } from "@/lib/format";
import Badge from "@/app/components/ui/Badge";
import type { UnallocatedPoursResponse } from "@/app/api/taproom/events/unallocated/route";
import type { OrphanCluster } from "@/lib/taproom/unallocatedEventPours";

const DAY_OPTIONS = [30, 60, 90, 180] as const;

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
function fmtDate(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

/**
 * Event Pours that were rung but fall outside every event's window, grouped
 * into same-day runs. Each run offers the two fixes that actually recover the
 * sale: stretch the nearby event's window to cover it, or create a new event
 * around it. Both go through the normal event edit/create paths, so the pours
 * route picks them up with no extra bookkeeping.
 */
export default function UnallocatedPoursPanel({
  onCreateFromCluster,
  onStretchEvent,
  stretching,
}: {
  onCreateFromCluster: (c: OrphanCluster) => void;
  onStretchEvent: (c: OrphanCluster) => void;
  stretching: boolean;
}) {
  const [days, setDays] = useState<number>(60);
  const { data, isFetching, error } = useQuery({
    queryKey: queryKeys.taproom.eventUnallocated(days),
    queryFn: () => fetchJson<UnallocatedPoursResponse>(`/api/taproom/events/unallocated?days=${days}`),
    staleTime: 60_000,
  });

  const clusters = data?.clusters ?? [];
  const totalGross = clusters.reduce((s, c) => s + c.gross_cents - c.discount_cents, 0);

  return (
    <div className={`rounded-lg border p-4 ${clusters.length ? "border-accent-border/40 bg-accent-muted/10" : "border-line bg-surface/30"}`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">Unallocated event pours</p>
          {!isFetching && clusters.length > 0 && (
            <Badge tone="accent">{clusters.length} {clusters.length === 1 ? "group" : "groups"} · {formatCurrencyCents(totalGross)} net</Badge>
          )}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          Last
          <select className="inp text-xs py-0.5" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {DAY_OPTIONS.map((d) => <option key={d} value={d}>{d} days</option>)}
          </select>
        </label>
      </div>

      {isFetching ? (
        <p className="text-xs text-faint py-3 text-center">Scanning Square for Event Pours outside every event window…</p>
      ) : error ? (
        <p className="text-xs text-danger mt-2">{error instanceof Error ? error.message : "Failed to scan"}</p>
      ) : clusters.length === 0 ? (
        <p className="text-xs text-faint italic mt-2">Every Event Pour rung in the last {days} days is covered by an event. Nothing to fix.</p>
      ) : (
        <div className="mt-3 space-y-2">
          {clusters.map((c) => (
            <div key={c.first_closed_at} className="rounded-md border border-line bg-surface px-3 py-2.5">
              <div className="flex items-start gap-3 flex-wrap">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-primary font-medium">
                    {fmtDate(c.date)}
                    <span className="text-muted font-normal"> · {fmtTime(c.first_closed_at)}{c.first_closed_at !== c.last_closed_at ? ` – ${fmtTime(c.last_closed_at)}` : ""}</span>
                  </p>
                  <p className="text-xs text-muted mt-0.5">
                    {c.quantity} pours on {c.order_count} {c.order_count === 1 ? "ticket" : "tickets"} · {formatCurrencyCents(c.gross_cents - c.discount_cents)} net
                    <span className="text-faint"> · {c.rows.map((r) => `${r.quantity} ${r.variation_name}`).join(", ")}</span>
                  </p>
                  {c.nearest_event && (
                    <p className="text-xs text-faint mt-0.5">
                      Closest event: <span className="text-body">{c.nearest_event.event_name}</span>
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {c.nearest_event && (
                    <button
                      type="button"
                      className="btn-primary btn-xxs"
                      disabled={stretching}
                      onClick={() => onStretchEvent(c)}
                      title={`Stretch ${c.nearest_event.event_name}'s window to cover these pours`}
                    >
                      Add to {c.nearest_event.event_name}
                    </button>
                  )}
                  <button
                    type="button"
                    className={c.nearest_event ? "btn-secondary btn-xxs" : "btn-primary btn-xxs"}
                    onClick={() => onCreateFromCluster(c)}
                  >
                    New event
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
