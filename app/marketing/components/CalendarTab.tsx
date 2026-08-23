"use client";

/**
 * The marketing calendar: a month of days, each holding what goes out that day.
 *
 * Shape is lifted from app/production/components/CalendarTab.tsx — same month
 * navigation, same seven-column grid, same "+N more" overflow — so a person
 * moving between Production's schedule and this one is looking at the same
 * object. That file predates the token rewrite and still uses raw `zinc-*`
 * utilities; the structure is copied and the colors are not.
 *
 * The grid itself is a calendar surface, which docs/UI_STANDARD.md §5 exempts
 * from the "no hand-rolled primitives" rule. Everything around it is not, and
 * uses the shared components.
 *
 * ── The two empty states are the shipping states ────────────────────────────
 * Production registers zero channel plugins (see lib/marketing/plugins/registry
 * .ts), so "nothing to connect yet" is what this screen looks like on the day
 * it ships, and "nothing connected" is what it looks like the day after a
 * plugin lands. Neither is an error. Both say what to do next.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import {
  addDays,
  addMonths,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfWeek,
  subMonths,
} from "date-fns";

import Banner from "@/app/components/ui/Banner";
import { TONE_SOFT } from "@/app/components/ui/tone";
import type { MarketingEntry } from "@/lib/marketing/entries";
import type { ConnectedAccountSummary } from "@/lib/marketing/accounts";
import { listChannels } from "@/lib/marketing/plugins/registry";
import { useEntriesQuery } from "../hooks/useMarketing";
import ComposeModal from "./ComposeModal";
import EntryDetailModal from "./EntryDetailModal";
import { ENTRY_STATUS_LABEL, ENTRY_STATUS_TONE, channelLabel } from "./status";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** How many entries fit in a day cell before the rest collapse into a count. */
const PER_DAY = 3;

export default function CalendarTab({
  accounts,
  canEdit,
  canPublish,
  canManageAccounts,
}: {
  accounts: ConnectedAccountSummary[];
  /** CAP.marketingCalendarEdit — the capability POST /api/marketing/entries enforces. */
  canEdit: boolean;
  /** CAP.marketingPublish — what the delivery retry route enforces. */
  canPublish: boolean;
  /** CAP.marketingAccountsManage, so the "connect one" sentence only points somewhere reachable. */
  canManageAccounts: boolean;
}) {
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [composing, setComposing] = useState(false);
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);

  const days = useMemo(() => {
    const first = startOfWeek(startOfMonth(month));
    const last = endOfWeek(endOfMonth(month));
    const out: Date[] = [];
    for (let d = first; d <= last; d = addDays(d, 1)) out.push(d);
    return out;
  }, [month]);

  // Half-open, matching the route: the first cell's midnight in, the day after
  // the last cell's midnight out. A closed window would put an entry sitting
  // exactly on a boundary into two months' grids.
  const fromIso = startOfDay(days[0]).toISOString();
  const toIso = startOfDay(addDays(days[days.length - 1], 1)).toISOString();
  const { data: entries = [], isLoading, error } = useEntriesQuery(fromIso, toIso);

  const registeredChannels = useMemo(() => listChannels().map((p) => p.channel), []);
  const connectedChannels = useMemo(
    () => accounts.filter((a) => a.status === "connected").map((a) => a.channel),
    [accounts],
  );

  // An entry with `ends_at` is a band, not a moment. Nothing creates one yet;
  // they are split out here so the rail below has something to hold the day the
  // first one appears, rather than the grid needing a re-layout.
  const bands = entries.filter((e) => e.endsAt !== null);
  const moments = entries.filter((e) => e.endsAt === null);
  const openEntry = entries.find((e) => e.id === openEntryId) ?? null;

  const today = new Date();

  return (
    <div>
      <div className="flex justify-end gap-2 mb-4">
        <button type="button" className="btn-primary" disabled={!canEdit} onClick={() => setComposing(true)}>
          Compose
        </button>
      </div>

      <ChannelNotice
        registered={registeredChannels.length}
        connected={connectedChannels.length}
        canManageAccounts={canManageAccounts}
      />

      {error && <Banner tone="danger" className="mb-4">{(error as Error).message}</Banner>}

      <div className="flex items-center gap-2 mb-4">
        <button type="button" className="btn-secondary" onClick={() => setMonth((m) => subMonths(m, 1))}>
          ‹
        </button>
        <h3 className="text-sm font-semibold text-strong">{format(month, "MMMM yyyy")}</h3>
        <button type="button" className="btn-secondary" onClick={() => setMonth((m) => addMonths(m, 1))}>
          ›
        </button>
        <button type="button" className="btn-secondary" onClick={() => setMonth(startOfMonth(today))}>
          Today
        </button>
        {isLoading && <span className="text-xs text-muted">Loading…</span>}
      </div>

      <BandRail bands={bands} onOpen={setOpenEntryId} />

      <div className="grid grid-cols-7 mb-1">
        {WEEKDAYS.map((dow) => (
          <div key={dow} className="text-xs text-muted font-medium text-center py-1">
            {dow}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-px bg-line-strong border border-line-strong rounded-lg overflow-hidden">
        {days.map((day) => {
          const inMonth = isSameMonth(day, month);
          const dayEntries = moments.filter((e) => isSameDay(parseISO(e.startsAt), day));
          return (
            <div
              key={day.toISOString()}
              className={`min-h-24 p-1.5 flex flex-col gap-1 ${inMonth ? "bg-surface" : "bg-canvas"}`}
            >
              <span
                className={`text-xs font-medium w-6 h-6 flex items-center justify-center rounded-full ${
                  isSameDay(day, today)
                    ? "bg-accent-emphasis text-canvas"
                    : inMonth
                      ? "text-body"
                      : "text-faint"
                }`}
              >
                {format(day, "d")}
              </span>

              {dayEntries.slice(0, PER_DAY).map((entry) => (
                <EntryTile key={entry.id} entry={entry} onOpen={() => setOpenEntryId(entry.id)} />
              ))}
              {dayEntries.length > PER_DAY && (
                <span className="text-2xs text-muted pl-1">+{dayEntries.length - PER_DAY} more</span>
              )}
            </div>
          );
        })}
      </div>

      {!isLoading && entries.length === 0 && (
        <p className="mt-6 text-sm text-muted text-center">
          Nothing on the calendar this month. Compose an entry to put something on it.
        </p>
      )}

      {composing && (
        <ComposeModal connectedChannels={connectedChannels} onClose={() => setComposing(false)} />
      )}
      {openEntry && (
        <EntryDetailModal entry={openEntry} canPublish={canPublish} onClose={() => setOpenEntryId(null)} />
      )}
    </div>
  );
}

/**
 * One entry in a day cell: its status as the tile's color, its channels
 * underneath. Both at a glance, which is the whole job of a calendar cell.
 *
 * Hand-rolled rather than a shared primitive because the grid is a calendar
 * surface — the documented exemption in docs/UI_STANDARD.md §5. The colors are
 * still the shared tone map, so a tile and a Badge agree about what "failed"
 * looks like.
 */
function EntryTile({ entry, onOpen }: { entry: MarketingEntry; onOpen: () => void }) {
  const label = entry.caption?.trim() || entry.kind;
  const channels = entry.deliveries.map((d) => channelLabel(d.channel));
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${ENTRY_STATUS_LABEL[entry.status]} — ${label}`}
      className={`w-full text-left rounded border px-1.5 py-0.5 ${TONE_SOFT[ENTRY_STATUS_TONE[entry.status]]}`}
    >
      <span className="block text-2xs font-medium truncate">{label}</span>
      <span className="block text-2xs truncate opacity-80">
        {channels.length > 0 ? channels.join(", ") : "no channel"}
      </span>
    </button>
  );
}

/**
 * The rail for entries that occupy a range rather than a moment.
 *
 * Empty today, and deliberately built anyway: nothing writes `ends_at` yet, and
 * the point of reserving the space is that the first band to arrive does not
 * force the grid below it to move.
 */
function BandRail({ bands, onOpen }: { bands: MarketingEntry[]; onOpen: (id: string) => void }) {
  return (
    <div className="mb-2 rounded-lg border border-line bg-surface px-3 py-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-secondary">Runs across days</p>
      {bands.length === 0 ? (
        <p className="text-xs text-muted mt-1">
          Nothing runs across days this month. A campaign that occupies a range rather than a moment will sit
          here, above the day it starts.
        </p>
      ) : (
        <ul className="mt-1 space-y-1">
          {bands.map((band) => (
            <li key={band.id}>
              <button
                type="button"
                onClick={() => onOpen(band.id)}
                className={`w-full text-left rounded border px-1.5 py-0.5 text-2xs ${
                  TONE_SOFT[ENTRY_STATUS_TONE[band.status]]
                }`}
              >
                {band.caption?.trim() || band.kind} · {format(parseISO(band.startsAt), "MMM d")} –{" "}
                {band.endsAt ? format(parseISO(band.endsAt), "MMM d") : ""}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * What to say when there is nowhere to post.
 *
 * Two different sentences for two genuinely different situations, and neither
 * is an error: with no plugin registered there is nothing a person could
 * connect, and with a plugin registered but no login there is something they
 * can go and do. The amber accent box is this app's caution treatment — there
 * is no `warning` color and those classes fail silently.
 */
function ChannelNotice({
  registered,
  connected,
  canManageAccounts,
}: {
  registered: number;
  connected: number;
  canManageAccounts: boolean;
}) {
  if (connected > 0) return null;
  return (
    <div className="mb-4 rounded-lg border border-accent-border/40 bg-accent-muted/20 px-4 py-2.5">
      {registered === 0 ? (
        <p className="text-sm text-accent-soft">
          No channel is set up in this app yet, so there is nothing to connect and nothing can go out. Entries
          saved here wait on the calendar as drafts until a channel arrives.
        </p>
      ) : (
        <p className="text-sm text-accent-soft">
          No account is connected yet, so nothing can be posted. An entry can still be saved as a draft with
          its channels chosen.{" "}
          {canManageAccounts && (
            <>
              Connect one in{" "}
              <Link href="/settings/marketing" className="underline hover:text-accent">
                Settings → Marketing
              </Link>
              .
            </>
          )}
        </p>
      )}
    </div>
  );
}
