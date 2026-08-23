/**
 * The human half of the publishing robot: putting a failed delivery back in the
 * queue.
 *
 * There are no automatic retries anywhere in marketing. A publish whose outcome
 * we are not sure of must not be repeated by a machine, because the failure
 * mode is a second post and you cannot un-post. So a failed delivery sits there
 * until a person looks at the error and decides. This module is that decision.
 *
 * The one thing a retry must NOT do is clear `external_ids`. Those ids are how
 * the plugin recognises work it has already done: `publish` is handed them, and
 * a non-empty bag means "this is already out there, return the same ids and do
 * not contact the provider". Wiping them would turn every retry into a fresh
 * publish, which is precisely the unrecoverable bug. `attempt_count` is left
 * alone too — it is the count of failures, and re-queueing is not one.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { runMarketingDeliveries } from "./worker";

const DELIVERIES = "marketing_deliveries";

/**
 * Why a retry was refused, so the route can answer 404 or 409 without
 * re-deriving it.
 */
export class DeliveryRetryError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
    this.name = "DeliveryRetryError";
  }
}

export interface RetriedDelivery {
  id: string;
  status: string;
  external_ids: Record<string, string> | null;
  attempt_count: number;
}

/**
 * Put exactly one failed delivery back on the queue, and publish it.
 *
 * Exactly one: there is no cascade to the entry's other channels. An entry that
 * went to three places and failed at one has one thing to retry, and re-sending
 * the two that worked would post them twice.
 *
 * The status change is a conditional update rather than a read followed by a
 * write, for the same reason the worker's claim is: two people pressing Retry
 * at the same moment must not both queue it. `where id = … and status =
 * 'failed'` means the second one updates nothing and is told so.
 *
 * Only `status` moves. `external_ids`, `attempt_count`, `scheduled_at` and
 * `published_at` are all left exactly as they were; `error` is left as the
 * record of what went wrong last time, and is cleared by the worker if and when
 * the delivery finally publishes.
 */
export interface RetryDeliveryOptions {
  /** Seam for tests. Defaults to the real worker. */
  runWorker?: (client: SupabaseClient) => Promise<unknown>;
}

export async function retryDelivery(
  client: SupabaseClient,
  id: string,
  options: RetryDeliveryOptions = {},
): Promise<RetriedDelivery> {
  const { data, error } = await client
    .from(DELIVERIES)
    .update({ status: "scheduled" })
    .eq("id", id)
    .eq("status", "failed")
    .select("id, status, external_ids, attempt_count");

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as unknown as RetriedDelivery[];
  if (rows.length === 1) {
    // Publish it now rather than leaving it for the sweep.
    //
    // The sweep runs ONCE A DAY — the Vercel Hobby plan refuses anything
    // faster — so a re-queued delivery that waited for it would sit untouched
    // for up to twenty-four hours while the screen said "Queued". A person who
    // reads an error, fixes the cause and presses Retry is asking for it to go
    // out, exactly as Post now is, and the two should behave the same way.
    //
    // Best-effort, for the same reason the Post-now path is: the row is
    // already committed as `scheduled`, and the worker's claim is safe to run
    // again, so a throw here costs promptness and nothing else — the next
    // sweep publishes precisely the same row. It cannot double-post either:
    // `external_ids` survived the re-queue, which is what makes the plugin
    // recognise work it has already done.
    const runWorker = options.runWorker ?? runMarketingDeliveries;
    try {
      await runWorker(client);
    } catch (err) {
      console.error(
        "[marketing:deliveries] the inline retry failed; the scheduled sweep will pick this delivery up",
        JSON.stringify({ deliveryId: id, error: err instanceof Error ? err.message : String(err) }),
      );
    }
    return rows[0];
  }

  // Nothing moved. Either there is no such delivery, or it is not failed — and
  // the caller deserves to be told which, in a sentence.
  const { data: existing, error: readErr } = await client
    .from(DELIVERIES)
    .select("id, status")
    .eq("id", id)
    .limit(1);
  if (readErr) throw new Error(readErr.message);

  const row = (existing ?? [])[0] as { status?: string } | undefined;
  if (!row) throw new DeliveryRetryError("There is no delivery with that id.", 404);

  throw new DeliveryRetryError(
    `Only a delivery that failed can be retried, and this one is ${row.status}.`,
    409,
  );
}
