/**
 * The publishing worker — the robot that posts what is on the calendar.
 *
 * This is the only part of the marketing chassis where a bug is unrecoverable.
 * You cannot un-post. Every decision below is arranged around that one fact,
 * and the two that matter most are the claim and the fail-fast order.
 *
 * ── The claim ───────────────────────────────────────────────────────────────
 * A delivery is claimed by ONE statement:
 *
 *     update marketing_deliveries
 *        set status = 'publishing'
 *      where status = 'scheduled' and scheduled_at <= $now
 *     returning *
 *
 * That single statement is the entire concurrency story. Under READ COMMITTED,
 * two transactions running it at the same time cannot both claim a row: the
 * second one blocks on the row lock the first took, and when the first commits
 * the second RE-EVALUATES its `where` against the new row version, sees
 * status = 'publishing', and drops the row from its result. The two claimed
 * sets are therefore disjoint, and their union is every eligible row.
 *
 * **Do not replace this with select-then-update.** A select followed by an
 * update is two statements with a window between them, and two workers will
 * both read `scheduled` and both publish — which posts twice. **And do not add
 * an application-level lock and call it equivalent.** `runCronJob` already
 * takes a per-job lease, and that lease is a genuinely weaker guarantee: it
 * stops two whole scheduled runs overlapping, and does nothing at all about a
 * scheduled run racing the "Run now" button, a second region, or a retried
 * invocation. The row-level claim is what makes this safe; the lease is a
 * courtesy on top of it.
 *
 * `$now` is this process's clock rather than SQL `now()` because that is what
 * PostgREST can express as a filter value. It changes nothing about the
 * atomicity above — the claim is still one statement, and the `where` is still
 * re-evaluated under the row lock. It only means "eligible" is decided by the
 * app server's clock instead of the database's, which for a five-minute cadence
 * is a distinction without a difference.
 *
 * ── Fail fast, then publish ─────────────────────────────────────────────────
 * Validation runs BEFORE publish and a failure short-circuits, because the
 * cheap thing to get wrong is a post that should never have gone out. Anything
 * that can be known without contacting a provider is checked while contacting a
 * provider is still avoidable.
 *
 * ── No automatic retries ────────────────────────────────────────────────────
 * A failed delivery stays failed until a person acts (see `./deliveries`).
 * There is no backoff and no dead-letter queue on purpose: an automatic retry
 * of a publish whose outcome we are unsure of is exactly the thing that posts
 * twice. The plugin's idempotency contract makes a HUMAN retry safe, and a
 * human retry is the only kind there is.
 *
 * ── Credentials ─────────────────────────────────────────────────────────────
 * The account handed to a plugin carries live tokens. Nothing in this module
 * logs an account, an error object it did not build itself, or any part of
 * `credentials`. Log lines carry ids, a channel and an outcome, and nothing
 * else.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getChannel } from "./plugins/registry";
import type {
  ConnectedAccount,
  Entry,
  EntryDetails,
  EntryOrigin,
  EntryStatus,
  Media,
  MediaType,
} from "./plugins/types";

const DELIVERIES = "marketing_deliveries";
const ENTRIES = "marketing_calendar_entries";
const ENTRY_MEDIA = "marketing_entry_media";
const ACCOUNTS = "marketing_connected_accounts";

/**
 * What one run did.
 *
 * `claimed` is the number of rows the claim statement returned, and is always
 * `published + failed + skipped` — every claimed row leaves 'publishing' with
 * an answer, because a row abandoned mid-flight is a delivery no later run will
 * ever look at again.
 */
export interface MarketingDeliveriesResult {
  claimed: number;
  published: number;
  failed: number;
  skipped: number;
}

/** `public.marketing_deliveries`, as the worker reads it. */
interface DeliveryRow {
  id: string;
  entry_id: string;
  account_id: string | null;
  channel: string;
  external_ids: Record<string, string> | null;
  attempt_count: number;
}

/** What a delivery's processing concluded, before it is written back. */
type Outcome =
  | { kind: "published"; externalIds: Record<string, string> }
  | { kind: "failed"; error: string }
  | { kind: "skipped"; reason: string };

/** The columns a plugin's `Entry` is built from. */
const ENTRY_COLUMNS = "id, kind, starts_at, ends_at, caption, details, status, origin, tags";

/**
 * Media for an entry, in carousel order, in one round trip.
 *
 * The order is `marketing_entry_media.position` and it is load-bearing — a
 * carousel published in the wrong order is a post that has to be deleted.
 */
const ENTRY_MEDIA_COLUMNS =
  "position, media:marketing_media(id, type, url, width, height, duration_s, bytes)";

/** The columns a plugin's `ConnectedAccount` is built from, credentials included. */
const ACCOUNT_COLUMNS =
  "id, provider, channel, external_id, external_parent_id, handle, credentials, token_expires_at, scopes";

/** Turn whatever a driver hands back for an error into a sentence. */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

/** One structured line per delivery. Ids and outcomes only — never an account. */
function log(row: Record<string, unknown>): void {
  console.log("[marketing:deliveries]", JSON.stringify(row));
}

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
    // `duration_s` is numeric in Postgres, which PostgREST may hand back as a
    // string. The contract says seconds as a number.
    durationS: row.duration_s === null || row.duration_s === undefined ? null : Number(row.duration_s),
    bytes: row.bytes === null || row.bytes === undefined ? null : Number(row.bytes),
  };
}

function toAccount(row: Record<string, unknown>): ConnectedAccount {
  return {
    id: String(row.id),
    provider: String(row.provider),
    channel: String(row.channel),
    externalId: String(row.external_id ?? ""),
    externalParentId: (row.external_parent_id as string | null) ?? null,
    handle: (row.handle as string | null) ?? null,
    credentials: (row.credentials as Record<string, unknown>) ?? {},
    tokenExpiresAt: (row.token_expires_at as string | null) ?? null,
    scopes: (row.scopes as string[] | null) ?? [],
  };
}

/**
 * An embedded to-one relation arrives as an object, but the generated types (and
 * some PostgREST shapes) allow an array. Accept both rather than guess.
 */
function firstEmbedded(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return (value[0] as Record<string, unknown>) ?? null;
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return null;
}

/** Work out what should happen to one claimed delivery, without writing anything. */
async function resolveOutcome(client: SupabaseClient, delivery: DeliveryRow): Promise<Outcome> {
  // ── 1. The entry, its media in order, and the account ─────────────────────
  const { data: entryRows, error: entryErr } = await client
    .from(ENTRIES)
    .select(ENTRY_COLUMNS)
    .eq("id", delivery.entry_id)
    .limit(1);
  if (entryErr) return { kind: "failed", error: `Could not load the calendar entry: ${messageOf(entryErr)}` };
  const entryRow = (entryRows ?? [])[0];
  if (!entryRow) return { kind: "failed", error: "The calendar entry behind this delivery no longer exists." };
  const entry = toEntry(entryRow as Record<string, unknown>);

  const { data: mediaRows, error: mediaErr } = await client
    .from(ENTRY_MEDIA)
    .select(ENTRY_MEDIA_COLUMNS)
    .eq("entry_id", delivery.entry_id)
    .order("position", { ascending: true });
  if (mediaErr) return { kind: "failed", error: `Could not load the entry's media: ${messageOf(mediaErr)}` };
  const media: Media[] = (mediaRows ?? [])
    .map((r) => firstEmbedded((r as Record<string, unknown>).media))
    .filter((r): r is Record<string, unknown> => r !== null)
    .map(toMedia);

  // A delivery whose account has been unlinked is SKIPPED, not failed. The FK
  // is `on delete set null`, so this is the shape a person deliberately
  // disconnecting a channel leaves behind: there is no credential to publish
  // with and no retry that could invent one. `skipped` is excluded from the
  // parent entry's status derivation, which is exactly right — the rest of the
  // entry's channels still decide whether it is done.
  if (!delivery.account_id) {
    return {
      kind: "skipped",
      reason: "The channel login this delivery was going to use has been disconnected, so it was not sent.",
    };
  }
  const { data: accountRows, error: accountErr } = await client
    .from(ACCOUNTS)
    .select(ACCOUNT_COLUMNS)
    .eq("id", delivery.account_id)
    .limit(1);
  if (accountErr) return { kind: "failed", error: `Could not load the channel login: ${messageOf(accountErr)}` };
  const accountRow = (accountRows ?? [])[0];
  if (!accountRow) {
    return {
      kind: "skipped",
      reason: "The channel login this delivery was going to use no longer exists, so it was not sent.",
    };
  }
  const account = toAccount(accountRow as Record<string, unknown>);

  // ── 2. The channel ────────────────────────────────────────────────────────
  // Production ships with an EMPTY registry, so an unregistered channel is the
  // ordinary state and not a "should never happen". It is a readable failure a
  // person can act on, never a throw out of the batch.
  const plugin = getChannel(delivery.channel);
  if (!plugin) {
    return {
      kind: "failed",
      error: `No channel is connected under the name "${delivery.channel}", so there is nothing to publish through.`,
    };
  }

  // ── 3. Validate, and stop here if it says no ──────────────────────────────
  // Fail fast: `publish` is NOT called. The reasons are sentences written for
  // whoever has to fix the entry.
  const verdict = plugin.validate(entry, media);
  if (!verdict.ok) return { kind: "failed", error: verdict.reasons.join(" ") };

  // ── 4. Publish ────────────────────────────────────────────────────────────
  // `externalIds` is the delivery's own — `{}` the first time, and whatever the
  // last successful publish returned after that. Handing it over is what lets a
  // plugin recognise already-published work and refuse to post it twice.
  try {
    const result = await plugin.publish({
      entry,
      media,
      account,
      externalIds: delivery.external_ids ?? {},
    });
    return { kind: "published", externalIds: { ...(delivery.external_ids ?? {}), ...result.externalIds } };
  } catch (err) {
    return { kind: "failed", error: messageOf(err) };
  }
}

/**
 * Claim every delivery that is due and publish it.
 *
 * Safe to run concurrently with itself — see the claim discussion at the top of
 * this file. Deliveries are processed one at a time rather than in parallel:
 * ordering is easier to reason about, a slow channel cannot starve the rest,
 * and nothing here is throughput-bound at a five-minute cadence.
 *
 * A single delivery blowing up never abandons the batch. Every path through one
 * delivery ends in a written status.
 */
export async function runMarketingDeliveries(client: SupabaseClient): Promise<MarketingDeliveriesResult> {
  // ── THE CLAIM. One statement. Do not split it. ───────────────────────────
  const { data: claimedRows, error: claimErr } = await client
    .from(DELIVERIES)
    .update({ status: "publishing" })
    .eq("status", "scheduled")
    .lte("scheduled_at", new Date().toISOString())
    .select("id, entry_id, account_id, channel, external_ids, attempt_count");

  if (claimErr) throw new Error(`could not claim scheduled deliveries: ${messageOf(claimErr)}`);

  const claimed = (claimedRows ?? []) as unknown as DeliveryRow[];
  const result: MarketingDeliveriesResult = {
    claimed: claimed.length,
    published: 0,
    failed: 0,
    skipped: 0,
  };
  if (claimed.length === 0) return result;

  for (const delivery of claimed) {
    // resolveOutcome catches a plugin's rejection itself; this guard is for the
    // rest of it — a driver error, a malformed row, a plugin that throws
    // synchronously out of `validate`. One delivery must never end the run.
    let outcome: Outcome;
    try {
      outcome = await resolveOutcome(client, delivery);
    } catch (err) {
      outcome = { kind: "failed", error: messageOf(err) };
    }

    const patch =
      outcome.kind === "published"
        ? {
            status: "published",
            external_ids: outcome.externalIds,
            published_at: new Date().toISOString(),
            // The last failure's reason, cleared now that it has succeeded. A
            // stale error sitting next to a published delivery reads as a live
            // problem.
            error: null,
          }
        : outcome.kind === "failed"
          ? {
              status: "failed",
              error: outcome.error,
              attempt_count: delivery.attempt_count + 1,
            }
          : { status: "skipped", error: outcome.reason };

    const { error: writeErr } = await client.from(DELIVERIES).update(patch).eq("id", delivery.id);

    if (writeErr) {
      // The worst case in this file: the post may be out and the row does not
      // say so. There is no safe automatic recovery — re-publishing is the one
      // thing that must not happen — so it is logged loudly, with the ids a
      // person needs to reconcile it by hand, and the row is left in
      // 'publishing' where it will not be claimed again.
      console.error(
        "[marketing:deliveries] could not record a delivery's outcome",
        JSON.stringify({
          deliveryId: delivery.id,
          entryId: delivery.entry_id,
          channel: delivery.channel,
          outcome: outcome.kind,
          externalIds: outcome.kind === "published" ? outcome.externalIds : undefined,
          error: messageOf(writeErr),
        }),
      );
    }

    if (outcome.kind === "published") result.published += 1;
    else if (outcome.kind === "failed") result.failed += 1;
    else result.skipped += 1;

    log({
      deliveryId: delivery.id,
      entryId: delivery.entry_id,
      channel: delivery.channel,
      outcome: outcome.kind,
      attempt: outcome.kind === "failed" ? delivery.attempt_count + 1 : delivery.attempt_count,
      // The failure reason is a sentence the plugin or this module wrote. No
      // account, no credential, no raw provider payload.
      reason: outcome.kind === "published" ? undefined : outcome.kind === "failed" ? outcome.error : outcome.reason,
    });
  }

  return result;
}
