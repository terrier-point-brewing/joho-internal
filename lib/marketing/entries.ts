/**
 * Calendar entries: creating one, and reading a window of them.
 *
 * This module is the only place a person's intent enters marketing, so it
 * carries the two rules the rest of the chassis assumes and cannot enforce:
 *
 *  1. **App code writes `draft` or `approved`, and nothing else.** Every other
 *     status on an entry is derived from its deliveries by
 *     `marketing_entry_status_refresh()`. Writing a derived status from here
 *     would be a bug even on the occasion it happened to be right, because the
 *     next delivery change would silently overwrite it — the app and the
 *     trigger would be two authors of one column.
 *
 *  2. **Nothing publishes without a human action.** There are exactly two ways
 *     to leave this module: an entry that sits on the calendar, and an entry a
 *     person just asked to go out NOW. A future `scheduled_at` is refused —
 *     the column exists and the worker honours it, but no caller can reach it
 *     yet, so "it will go out on Friday" is never a promise this app has made
 *     and failed to keep.
 *
 * ── Media order ─────────────────────────────────────────────────────────────
 * `mediaIds` is an ORDERED list and the order is the caller's. It is persisted
 * as `marketing_entry_media.position` and read back by that column, because it
 * is the one fact here that a later bug cannot re-derive: nothing in a row says
 * which slide of a carousel a person meant to be first, so if the order is lost
 * it is lost for good.
 *
 * ── details ─────────────────────────────────────────────────────────────────
 * Passed through untouched. The chassis never reads it; see `EntryDetails`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { dayStartUtc } from "@/lib/utils/datetime";
import { MarketingRequestError } from "./errors";
import { getChannel } from "./plugins/registry";
import type { Entry, EntryDetails, EntryOrigin, EntryStatus, Media, MediaType } from "./plugins/types";
import { runMarketingDeliveries } from "./worker";

const ENTRIES = "marketing_calendar_entries";
const ENTRY_MEDIA = "marketing_entry_media";
const MEDIA = "marketing_media";
const DELIVERIES = "marketing_deliveries";
const ACCOUNTS = "marketing_connected_accounts";

/** The only statuses app code may write. The rest belong to the trigger. */
export const APP_WRITABLE_STATUSES = ["draft", "approved"] as const;

const ENTRY_COLUMNS = "id, kind, starts_at, ends_at, caption, details, status, origin, tags";
const ENTRY_MEDIA_COLUMNS =
  "entry_id, position, media:marketing_media(id, type, url, width, height, duration_s, bytes)";

/**
 * The delivery columns a response may carry.
 *
 * `account_id` is a row id, not a credential. The account table's secret column
 * is never named in this module — see `CREDENTIAL_FREE_ACCOUNT_COLUMNS` below,
 * which is the only shape of that table anything here ever selects.
 */
const DELIVERY_COLUMNS =
  "id, entry_id, channel, status, error, external_ids, scheduled_at, published_at, attempt_count, account_id";

/** Looking up which account publishes a channel. Deliberately four harmless columns. */
const CREDENTIAL_FREE_ACCOUNT_COLUMNS = "id, provider, channel, status";

/** One delivery as a caller sees it. No credential, and no account beyond its id. */
export interface EntryDelivery {
  id: string;
  channel: string;
  status: string;
  error: string | null;
  externalIds: Record<string, string>;
  scheduledAt: string | null;
  publishedAt: string | null;
  attemptCount: number;
  accountId: string | null;
}

/** An entry with everything one screen needs: its media in order, and its deliveries. */
export interface MarketingEntry extends Entry {
  media: Media[];
  deliveries: EntryDelivery[];
}

// ── Parsing ─────────────────────────────────────────────────────────────────

const isoInstant = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), "must be an ISO 8601 date-time");

/**
 * The request body.
 *
 * `strictObject` on purpose: an unknown key is almost always a caller believing
 * in a field this route does not have, and silently dropping it is how a person
 * ends up sure they scheduled something that was never scheduled.
 */
const createEntryBody = z.strictObject({
  kind: z.string().trim().min(1, "kind is required"),
  startsAt: isoInstant,
  endsAt: isoInstant.nullish(),
  caption: z.string().nullish(),
  /** Opaque. The chassis never looks inside. */
  details: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(APP_WRITABLE_STATUSES).optional(),
  tags: z.array(z.string()).optional(),
  /** ORDERED. Position 0 is the first slide. */
  mediaIds: z.array(z.uuid()).optional(),
  /** Channel keys, resolved through the registry. Only meaningful with postNow. */
  channels: z.array(z.string().min(1)).optional(),
  postNow: z.boolean().optional(),
});

export type CreateEntryInput = z.infer<typeof createEntryBody>;

/**
 * Turn an unparsed body into an input, or into one sentence saying why not.
 *
 * Two rejections get their own wording rather than Zod's, because they are the
 * two a person is most likely to hit and the generic message would read as a
 * bug in the app rather than a rule of it.
 */
export function parseCreateEntry(raw: unknown): CreateEntryInput {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MarketingRequestError("Expected a JSON object.");
  }
  const body = raw as Record<string, unknown>;

  if ("scheduledAt" in body || "scheduled_at" in body) {
    throw new MarketingRequestError(
      "Scheduling a post for later is not available yet. An entry can be saved as a draft, or posted now.",
    );
  }
  if ("status" in body && !(APP_WRITABLE_STATUSES as readonly unknown[]).includes(body.status)) {
    throw new MarketingRequestError(
      `status may only be ${APP_WRITABLE_STATUSES.join(" or ")}. ` +
        "Every other status is worked out from the entry's deliveries as they publish, so it cannot be set here.",
    );
  }
  if ("origin" in body) {
    throw new MarketingRequestError("origin is not settable: an entry created here is always a person's, so it is 'manual'.");
  }

  const parsed = createEntryBody.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue.path.join(".");
    throw new MarketingRequestError(path ? `${path}: ${issue.message}` : issue.message);
  }

  const input = parsed.data;
  const channels = [...new Set(input.channels ?? [])];

  if (input.postNow && channels.length === 0) {
    throw new MarketingRequestError("Posting now needs at least one channel to post to.");
  }
  // Deliveries are created ONLY by posting now, and this is not pedantry: the
  // moment a delivery exists the trigger derives the entry's status from it, so
  // a draft carrying a pending delivery would immediately stop reading as a
  // draft. Channels chosen for a draft are the compose screen's business until
  // the person actually says go.
  if (!input.postNow && channels.length > 0) {
    throw new MarketingRequestError(
      "Channels are only used when posting now. Save the entry as a draft without them, or post it now.",
    );
  }
  if (input.mediaIds && new Set(input.mediaIds).size !== input.mediaIds.length) {
    throw new MarketingRequestError("The same piece of media is listed twice; an entry uses each one once.");
  }

  return { ...input, channels };
}

/**
 * The `[from, to)` window a GET asks for, as two UTC instants.
 *
 * **Half-open, deliberately.** An entry exactly at `from` is in; an entry
 * exactly at `to` is not. That is what lets a caller page through a year a week
 * at a time without an entry landing in two windows or in neither — which is
 * the failure mode of a closed interval, and one that shows up as a duplicate
 * on a calendar rather than as an error.
 *
 * A bare `YYYY-MM-DD` is read as midnight **brewery-local** (see
 * lib/utils/datetime.ts), because a person asking for "this week" means the
 * week in the taproom, not in UTC. A full ISO instant is taken as given.
 */
export function parseEntryWindow(from: string | null, to: string | null): { fromIso: string; toIso: string } {
  if (!from || !to) throw new MarketingRequestError("from and to are required.");
  const fromIso = toInstant(from, "from");
  const toIso = toInstant(to, "to");
  if (fromIso >= toIso) throw new MarketingRequestError("from must be earlier than to.");
  return { fromIso, toIso };
}

function toInstant(value: string, field: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return dayStartUtc(value);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new MarketingRequestError(`${field} is not a date I can read.`);
  return new Date(ms).toISOString();
}

// ── Row → boundary shape ────────────────────────────────────────────────────

function toEntry(row: Record<string, unknown>): Entry {
  return {
    id: String(row.id),
    kind: String(row.kind),
    startsAt: String(row.starts_at),
    endsAt: (row.ends_at as string | null) ?? null,
    caption: (row.caption as string | null) ?? null,
    details: (row.details as EntryDetails) ?? {},
    status: row.status as EntryStatus,
    origin: row.origin as EntryOrigin,
    tags: (row.tags as string[] | null) ?? [],
  };
}

function toMedia(row: Record<string, unknown>): Media {
  return {
    id: String(row.id),
    type: row.type as MediaType,
    url: String(row.url),
    width: (row.width as number | null) ?? null,
    height: (row.height as number | null) ?? null,
    durationS: row.duration_s === null || row.duration_s === undefined ? null : Number(row.duration_s),
    bytes: row.bytes === null || row.bytes === undefined ? null : Number(row.bytes),
  };
}

function toDelivery(row: Record<string, unknown>): EntryDelivery {
  return {
    id: String(row.id),
    channel: String(row.channel),
    status: String(row.status),
    error: (row.error as string | null) ?? null,
    externalIds: (row.external_ids as Record<string, string> | null) ?? {},
    scheduledAt: (row.scheduled_at as string | null) ?? null,
    publishedAt: (row.published_at as string | null) ?? null,
    attemptCount: Number(row.attempt_count ?? 0),
    accountId: (row.account_id as string | null) ?? null,
  };
}

/** An embedded to-one relation arrives as an object or a one-element array. Accept both. */
function firstEmbedded(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return (value[0] as Record<string, unknown>) ?? null;
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return null;
}

function failOn(error: { message: string } | null, what: string): void {
  if (error) throw new Error(`${what}: ${error.message}`);
}

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * Load a set of entries by id, with media in order and deliveries attached.
 *
 * Three round trips rather than one nested select: the media order has to be
 * applied by the database (`order("position")`) rather than by whatever order a
 * nested embed happens to return, and doing it in its own statement is how that
 * stays true no matter what PostgREST does with the embed.
 */
async function hydrate(client: SupabaseClient, entryRows: Record<string, unknown>[]): Promise<MarketingEntry[]> {
  if (entryRows.length === 0) return [];
  const ids = entryRows.map((r) => String(r.id));

  const { data: mediaRows, error: mediaErr } = await client
    .from(ENTRY_MEDIA)
    .select(ENTRY_MEDIA_COLUMNS)
    .in("entry_id", ids)
    .order("position", { ascending: true });
  failOn(mediaErr, "could not load the entries' media");

  const { data: deliveryRows, error: deliveryErr } = await client
    .from(DELIVERIES)
    .select(DELIVERY_COLUMNS)
    .in("entry_id", ids)
    .order("channel", { ascending: true });
  failOn(deliveryErr, "could not load the entries' deliveries");

  const mediaByEntry = new Map<string, Media[]>();
  for (const row of (mediaRows ?? []) as Record<string, unknown>[]) {
    const embedded = firstEmbedded(row.media);
    if (!embedded) continue;
    const key = String(row.entry_id);
    const list = mediaByEntry.get(key) ?? [];
    list.push(toMedia(embedded));
    mediaByEntry.set(key, list);
  }

  const deliveriesByEntry = new Map<string, EntryDelivery[]>();
  for (const row of (deliveryRows ?? []) as Record<string, unknown>[]) {
    const key = String(row.entry_id);
    const list = deliveriesByEntry.get(key) ?? [];
    list.push(toDelivery(row));
    deliveriesByEntry.set(key, list);
  }

  return entryRows.map((row) => ({
    ...toEntry(row),
    media: mediaByEntry.get(String(row.id)) ?? [],
    deliveries: deliveriesByEntry.get(String(row.id)) ?? [],
  }));
}

/**
 * Every entry whose `starts_at` falls in `[from, to)`, oldest first.
 *
 * One call's worth of everything a calendar and an entry detail pane need — a
 * month view that had to fetch each entry's media separately would make a
 * hundred requests to draw a grid.
 */
export async function listEntries(
  client: SupabaseClient,
  window: { fromIso: string; toIso: string },
): Promise<MarketingEntry[]> {
  const { data, error } = await client
    .from(ENTRIES)
    .select(ENTRY_COLUMNS)
    .gte("starts_at", window.fromIso)
    .lt("starts_at", window.toIso)
    .order("starts_at", { ascending: true });
  failOn(error, "could not load the calendar");
  return hydrate(client, (data ?? []) as Record<string, unknown>[]);
}

/** One entry by id, hydrated the same way, or null. */
export async function getEntry(client: SupabaseClient, id: string): Promise<MarketingEntry | null> {
  const { data, error } = await client.from(ENTRIES).select(ENTRY_COLUMNS).eq("id", id).limit(1);
  failOn(error, "could not load the entry");
  const rows = (data ?? []) as Record<string, unknown>[];
  if (rows.length === 0) return null;
  return (await hydrate(client, rows))[0];
}

// ── Writing ─────────────────────────────────────────────────────────────────

export interface CreateEntryOptions {
  /** `auth.users.id` of the person doing this, for `created_by`. */
  createdBy?: string | null;
  /** The instant "now" means. Injectable so a test does not race the clock. */
  now?: Date;
  /**
   * The inline publish. Injectable ONLY so a test can prove the request
   * survives a worker that throws; production always passes the real one.
   */
  runWorker?: (client: SupabaseClient) => Promise<unknown>;
}

/**
 * Create one entry, its ordered media rows and — when a person is posting now —
 * its deliveries.
 *
 * The writes are sequential and not transactional, because PostgREST gives us
 * no transaction to put them in. The order is chosen so that every partial
 * failure leaves something harmless: an entry with no media reads as a
 * text-only entry, and an entry with media but no deliveries reads as a draft
 * nobody posted. The order that would be dangerous — deliveries before the
 * media they are meant to carry — is the one that never happens.
 */
export async function createEntry(
  client: SupabaseClient,
  input: CreateEntryInput,
  options: CreateEntryOptions = {},
): Promise<MarketingEntry> {
  const now = options.now ?? new Date();
  const mediaIds = input.mediaIds ?? [];
  const channels = input.channels ?? [];
  const postNow = input.postNow === true;

  // ── 1. Everything that can be refused, refused before anything is written ─
  if (mediaIds.length > 0) {
    const { data, error } = await client.from(MEDIA).select("id").in("id", mediaIds);
    failOn(error, "could not check the entry's media");
    const found = new Set(((data ?? []) as Record<string, unknown>[]).map((r) => String(r.id)));
    const missing = mediaIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new MarketingRequestError(`No media exists with the id ${missing[0]}.`, 404);
    }
  }

  const accountByChannel = new Map<string, string>();
  if (postNow) {
    for (const channel of channels) {
      // Through the registry, always. No route and no lib function in marketing
      // names a channel in its own source.
      if (!getChannel(channel)) {
        throw new MarketingRequestError(`There is no channel called "${channel}".`, 404);
      }
    }
    const { data, error } = await client
      .from(ACCOUNTS)
      .select(CREDENTIAL_FREE_ACCOUNT_COLUMNS)
      .in("channel", channels);
    failOn(error, "could not load the channel logins");
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      if (row.status === "connected") accountByChannel.set(String(row.channel), String(row.id));
    }
    for (const channel of channels) {
      if (!accountByChannel.has(channel)) {
        throw new MarketingRequestError(
          `Nothing is connected for "${channel}" yet, so there is no login to post through. Connect it on the Accounts screen first.`,
          409,
        );
      }
    }
  }

  // ── 2. The entry ─────────────────────────────────────────────────────────
  // Posting now IS approving: a person pressed the button. `approved` is still
  // one of the two statuses app code may write — the trigger takes it from
  // there the moment the deliveries below land.
  const status: (typeof APP_WRITABLE_STATUSES)[number] = postNow ? "approved" : (input.status ?? "draft");

  const { data: entryRows, error: entryErr } = await client
    .from(ENTRIES)
    .insert({
      kind: input.kind,
      starts_at: input.startsAt,
      ends_at: input.endsAt ?? null,
      caption: input.caption ?? null,
      details: input.details ?? {},
      status,
      // Always 'manual' from this route. 'assistant' is valid in the schema and
      // written by nothing.
      origin: "manual" satisfies EntryOrigin,
      tags: input.tags ?? [],
      created_by: options.createdBy ?? null,
      // updated_at is the trigger's. Never set from app code.
    })
    .select(ENTRY_COLUMNS);
  failOn(entryErr, "could not create the entry");
  const entryRow = ((entryRows ?? []) as Record<string, unknown>[])[0];
  if (!entryRow) throw new Error("could not create the entry: the insert returned no row");
  const entryId = String(entryRow.id);

  // ── 3. The media, in the caller's order ──────────────────────────────────
  // `position` is the index in the array the caller sent, and that is the whole
  // mechanism. Nothing else records what a person meant by "first".
  if (mediaIds.length > 0) {
    const { error } = await client
      .from(ENTRY_MEDIA)
      .insert(mediaIds.map((mediaId, position) => ({ entry_id: entryId, media_id: mediaId, position })));
    failOn(error, "could not attach the entry's media");
  }

  // ── 4. The deliveries, only when posting now ─────────────────────────────
  if (postNow) {
    const { error } = await client.from(DELIVERIES).insert(
      channels.map((channel) => ({
        entry_id: entryId,
        account_id: accountByChannel.get(channel)!,
        channel,
        // now(), not a future time. Scheduling is not reachable from here.
        scheduled_at: now.toISOString(),
        status: "scheduled",
      })),
    );
    failOn(error, "could not queue the entry for publishing");

    // ── 5. Publish inline, best effort ─────────────────────────────────────
    // The cron sweep runs DAILY, so waiting for it would mean "post now" posts
    // tomorrow. This inline run is what makes the button honest.
    //
    // It is best-effort on purpose: everything above is already committed, and
    // the worker's claim is safe to run again, so a throw here costs the caller
    // nothing except promptness — the next sweep publishes exactly the same
    // rows. Swallowing it is therefore correct, and reporting a failed request
    // for an entry that IS on the calendar would be a lie.
    const runWorker = options.runWorker ?? runMarketingDeliveries;
    try {
      await runWorker(client);
    } catch (err) {
      console.error(
        "[marketing:entries] the inline publish failed; the scheduled sweep will pick these deliveries up",
        JSON.stringify({ entryId, channels, error: err instanceof Error ? err.message : String(err) }),
      );
    }
  }

  const created = await getEntry(client, entryId);
  if (!created) throw new Error("could not read back the entry that was just created");
  return created;
}
