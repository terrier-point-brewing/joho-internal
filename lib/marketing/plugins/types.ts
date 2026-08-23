/**
 * The channel plugin contract.
 *
 * Marketing is one calendar and a robot that publishes what is on it. A channel
 * plugin is the ONLY thing in the app that knows how a specific outside service
 * works — its OAuth dance, what it will refuse to accept, and how a post is
 * actually made. The worker, the routes and the UI reach a channel exclusively
 * through the registry (`./registry`), so adding a channel later is one folder
 * plus one registry line and no edits anywhere else.
 *
 * Everything here is pure type declaration. Nothing in this module — or in any
 * chassis module that consumes it — performs I/O.
 *
 * The types below mirror the columns in `public.marketing_*` (camelCased at the
 * boundary, as the rest of this repo does). They are the plugin's view of a row,
 * not the row: chassis-only bookkeeping such as a delivery's `attempt_count` or
 * an account's `last_error` is deliberately absent, because a plugin has no
 * business acting on it.
 */

/** `marketing_calendar_entries.status`. App code sets only draft/approved; the rest is derived. */
export type EntryStatus = "draft" | "approved" | "scheduled" | "in_progress" | "done" | "failed";

/** `marketing_calendar_entries.origin`. `assistant` is valid from day one and written by nothing yet. */
export type EntryOrigin = "manual" | "rule" | "assistant";

/** `marketing_media.type`. `video` is accepted everywhere and handled by almost nothing — an open extension point. */
export type MediaType = "image" | "video";

/**
 * The per-kind bag on an entry (`marketing_calendar_entries.details`).
 *
 * **Owned by plugins. The chassis never reads it.** A plugin puts whatever its
 * channel needs in here — a first comment, a location id, a boost budget — and
 * nothing between the compose form and `publish` interprets it. It is typed as
 * an opaque record on purpose: giving the chassis a reason to look inside is how
 * a plugin's private business becomes everybody's problem.
 */
export type EntryDetails = Record<string, unknown>;

/** One thing on the calendar. Mirrors `public.marketing_calendar_entries`. */
export interface Entry {
  id: string;
  /** Free text, e.g. "post" | "reel" | "story" | "boost". Plugins decide what they accept. */
  kind: string;
  /** ISO 8601. Always present. */
  startsAt: string;
  /** ISO 8601, or null. Null means the entry is a moment; set means it is a band. */
  endsAt: string | null;
  /** Nullable in the table — a text-less entry that is only media is legal. */
  caption: string | null;
  /** Opaque to the chassis. See {@link EntryDetails}. */
  details: EntryDetails;
  status: EntryStatus;
  origin: EntryOrigin;
  tags: string[];
}

/**
 * One piece of the marketing library. Mirrors `public.marketing_media`.
 *
 * The dimension columns are nullable because they are whatever the upload could
 * be measured for: an image has `width`/`height` and no `durationS`, a video has
 * the reverse-ish, and a link-only creative may have neither. A plugin that
 * needs one is expected to say so in `validate`, in a sentence, rather than
 * assume it.
 *
 * `storage_path` is absent on purpose — where the bytes live is the chassis's
 * business, and `url` is the only address a plugin should ever need.
 */
export interface Media {
  id: string;
  type: MediaType;
  url: string;
  width: number | null;
  height: number | null;
  /** Duration in whole seconds (`duration_s`). Null for stills. */
  durationS: number | null;
  bytes: number | null;
}

/**
 * What a completed OAuth callback hands back, for insertion into
 * `public.marketing_connected_accounts`.
 *
 * `credentials` is SECRET. It reaches a service-role-only table and must never
 * appear in an API response, a log line, or an error message.
 */
export interface ConnectedAccountInput {
  provider: string;
  channel: string;
  /** The account's id at the provider. */
  externalId: string;
  /** The page/business the account hangs off, where the provider has one. Null otherwise. */
  externalParentId: string | null;
  /** Display handle, for showing a person which login this is. Null if the provider gives none. */
  handle: string | null;
  /** SECRET — tokens and whatever else the provider needs on the next call. */
  credentials: Record<string, unknown>;
  /** ISO 8601, or null when the provider issues a credential that does not expire. */
  tokenExpiresAt: string | null;
  scopes: string[];
}

/**
 * A stored connected account as a plugin sees it: the input it produced, plus
 * the row id the chassis gave it. Status and error bookkeeping stay out — those
 * are the chassis's answer to a failure, not the plugin's input.
 */
export interface ConnectedAccount extends ConnectedAccountInput {
  id: string;
}

/**
 * Whether a channel will accept an entry as it currently stands.
 *
 * `reasons` are read by a person in Compose, next to a channel that has been
 * disabled for them. They are **sentences, not codes** — "A reel needs a video."
 * and not "MISSING_VIDEO" — because there is no layer between this string and
 * the human eye that will translate it.
 */
export type ValidationResult = { ok: true } | { ok: false; reasons: string[] };

/**
 * Everything a plugin needs to publish one delivery, and nothing else.
 *
 * `externalIds` is the delivery's `marketing_deliveries.external_ids` as it
 * stands right now — `{}` before anything has been published, and whatever the
 * last successful `publish` returned afterwards. **It is the idempotency key.**
 * See {@link ChannelPlugin.publish}.
 */
export interface PublishContext {
  entry: Entry;
  /** Ordered by `marketing_entry_media.position`. Empty is legal: a text-only entry. */
  media: Media[];
  account: ConnectedAccount;
  /** Already-published ids for THIS delivery. Non-empty means the work is done. */
  externalIds: Record<string, string>;
}

/**
 * What a publish produced, to be merged into `marketing_deliveries.external_ids`.
 *
 * A map rather than one id because a real channel routinely mints more than one
 * — a media container and then the post made from it, say — and the chassis must
 * not assume a shape it cannot know.
 */
export interface PublishResult {
  externalIds: Record<string, string>;
}

/** How a plugin gets a person from "connect" to a stored account. No I/O happens here except inside `callback`. */
export interface ChannelConnect {
  /**
   * The provider URL to send the browser to. `state` is the chassis's CSRF
   * token and must be round-tripped verbatim.
   */
  authUrl(state: string): string;
  /** Exchange the provider's `code` for a storable account. The one place in `connect` that talks to a network. */
  callback(code: string, state: string): Promise<ConnectedAccountInput>;
}

/**
 * One channel. The only thing that knows how a specific service works.
 */
export interface ChannelPlugin {
  /** Stable key, unique across the registry. Also `marketing_deliveries.channel`. */
  channel: string;
  /** The service behind the channel. Several channels can share one provider. */
  provider: string;
  connect: ChannelConnect;
  /**
   * Synchronous by design: Compose calls this on every keystroke to decide
   * whether a channel is offerable, so it must never await anything.
   */
  validate(entry: Entry, media: Media[]): ValidationResult;
  /**
   * Publish one delivery.
   *
   * **Idempotency is part of the contract, not a nicety.** Every delivery is
   * retryable, and a retry that posts a second time is unrecoverable — you
   * cannot un-post. So: if `ctx.externalIds` is non-empty, this delivery has
   * already been published; return those same ids and do not contact the
   * provider again. The fake plugin (`./fake`) is where that behaviour is
   * specified in tests, and every real plugin is held to it.
   *
   * Rejects on failure. The chassis records the error and decides about retries.
   */
  publish(ctx: PublishContext): Promise<PublishResult>;
}
