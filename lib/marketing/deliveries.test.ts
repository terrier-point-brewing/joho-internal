/**
 * Retry — the only kind of retry marketing has, and the reason it is safe.
 *
 * The last block is the important one: it retries a delivery that already
 * published, runs the worker again, and proves the plugin recognised its own
 * work and did NOT contact the provider a second time. That is the whole chain
 * — retry keeps `external_ids`, the worker hands them to `publish`, `publish`
 * returns them untouched — and every link has to hold or something gets posted
 * twice.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { DeliveryRetryError, retryDelivery } from "./deliveries";
import { runMarketingDeliveries } from "./worker";
import { registerChannel } from "./plugins/registry";
import { createFakeChannelPlugin } from "./plugins/fake";
import {
  createMarketingTestDb,
  testAccount,
  testDelivery,
  testEntry,
  type MarketingTables,
} from "./__fixtures__/marketingDb";

const asClient = (db: { client: unknown }) => db.client as unknown as SupabaseClient;

/**
 * Retry publishes inline, so the tests about the QUEUEING rule pass a worker
 * that does nothing. They are about which row moves and what survives on it;
 * letting the real worker run would publish the row out from under the
 * assertion and test two things at once.
 */
const noPublish = { runWorker: async () => {} };

const CHANNEL = "t-retry";
// Rejects the first real attempt, then succeeds — the shape the retry path is
// tested against. An idempotent hit is not an attempt, so it never reaches this.
const plugin = createFakeChannelPlugin({ channel: CHANNEL, outcome: "succeed-after-retry" });
registerChannel(plugin);

beforeEach(() => {
  plugin.reset();
  plugin.setOutcome("succeed-after-retry");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function seed(over: Record<string, unknown> = {}): Partial<MarketingTables> {
  return {
    marketing_connected_accounts: [testAccount(CHANNEL)],
    marketing_calendar_entries: [testEntry("entry-0")],
    marketing_deliveries: [testDelivery("del-0", "entry-0", CHANNEL, over)],
  };
}

describe("retrying a failed delivery", () => {
  it("puts exactly that row back on the queue and touches nothing else on it", async () => {
    const db = createMarketingTestDb(
      seed({
        status: "failed",
        error: "the provider said no",
        attempt_count: 3,
        external_ids: { post: "p-1" },
        published_at: null,
      }),
    );

    const returned = await retryDelivery(asClient(db), "del-0", noPublish);

    expect(returned.status).toBe("scheduled");
    const row = db.tables.marketing_deliveries[0];
    expect(row.status).toBe("scheduled");
    // The one that matters: the ids the plugin uses to recognise its own work.
    expect(row.external_ids).toEqual({ post: "p-1" });
    // Re-queueing is not a failure, so the counter does not move; the error
    // stays as the record of what went wrong, and the worker clears it on success.
    expect(row.attempt_count).toBe(3);
    expect(row.error).toBe("the provider said no");
    expect(row.scheduled_at).toBe("2020-01-01T00:00:00.000Z");
  });

  it("does not cascade to the entry's other channels", async () => {
    const s = seed({ status: "failed" });
    s.marketing_deliveries!.push(
      testDelivery("del-1", "entry-0", CHANNEL, { status: "published" }),
      testDelivery("del-2", "entry-0", CHANNEL, { status: "failed" }),
    );
    const db = createMarketingTestDb(s);

    await retryDelivery(asClient(db), "del-0", noPublish);

    // Re-sending the one that worked would post it twice; the other failure is
    // its own decision for a person to make.
    expect(db.tables.marketing_deliveries.map((d) => d.status)).toEqual([
      "scheduled",
      "published",
      "failed",
    ]);
  });

  it("refuses anything that is not failed, with a sentence and a 409", async () => {
    for (const status of ["pending", "scheduled", "publishing", "published", "skipped"]) {
      const db = createMarketingTestDb(seed({ status }));
      await expect(retryDelivery(asClient(db), "del-0", noPublish)).rejects.toMatchObject({
        status: 409,
        message: `Only a delivery that failed can be retried, and this one is ${status}.`,
      });
      expect(db.tables.marketing_deliveries[0].status).toBe(status);
    }
  });

  it("answers 404 for a delivery that does not exist", async () => {
    const db = createMarketingTestDb(seed({ status: "failed" }));
    await expect(retryDelivery(asClient(db), "nope", noPublish)).rejects.toBeInstanceOf(DeliveryRetryError);
    await expect(retryDelivery(asClient(db), "nope", noPublish)).rejects.toMatchObject({ status: 404 });
  });

  it("lets only one of two simultaneous presses through", async () => {
    const db = createMarketingTestDb(seed({ status: "failed" }));

    const outcomes = await Promise.allSettled([
      retryDelivery(asClient(db), "del-0", noPublish),
      retryDelivery(asClient(db), "del-0", noPublish),
    ]);

    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);
  });
});

describe("retry publishes inline", () => {
  it("runs the worker itself, because the sweep is a day away", async () => {
    // The scheduled sweep runs ONCE A DAY (Vercel Hobby refuses anything
    // faster), so a retry that only re-queued would leave the screen saying
    // "Queued" for up to twenty-four hours. Pressing Retry is a request to
    // publish, exactly as Post now is.
    const db = createMarketingTestDb(seed({ status: "failed" }));
    const runWorker = vi.fn(async () => {});

    await retryDelivery(asClient(db), "del-0", { runWorker });

    expect(runWorker).toHaveBeenCalledTimes(1);
  });

  it("still succeeds when the inline publish throws, leaving the row for the sweep", async () => {
    // Best-effort, like the Post-now path: the row is already committed as
    // scheduled and the claim is safe to re-run, so a throw costs promptness
    // and nothing else. Reporting a failed retry for a delivery that IS back
    // on the queue would be a lie.
    const db = createMarketingTestDb(seed({ status: "failed" }));
    const runWorker = vi.fn(async () => {
      throw new Error("the sweep exploded");
    });

    const returned = await retryDelivery(asClient(db), "del-0", { runWorker });

    expect(returned.status).toBe("scheduled");
    expect(db.tables.marketing_deliveries[0].status).toBe("scheduled");
  });
});

describe("retry, then the worker, on a delivery that already published", () => {
  it("returns the existing ids without publishing again", async () => {
    // The failure is real: this delivery's publish threw AFTER the provider had
    // accepted the post, so the row says failed while the post is out there.
    // This is exactly the case a re-publish would turn into two posts.
    const db = createMarketingTestDb(
      seed({
        status: "failed",
        error: "the connection dropped",
        attempt_count: 1,
        external_ids: { container: "fake-container-entry-0", post: "fake-post-entry-0" },
      }),
    );
    // The fake would happily publish if it were asked — the outcome is set to
    // succeed — so a `reused` below is the plugin's own idempotency, not luck.
    plugin.setOutcome("succeed");
    const attemptsBefore = plugin.publishAttempts();

    // Retry publishes inline — no separate worker run is needed, and this is
    // the path a person actually takes when they press the button.
    await retryDelivery(asClient(db), "del-0");

    // Running the sweep afterwards must find nothing left and change nothing:
    // the inline publish already finished the job.
    const sweep = await runMarketingDeliveries(asClient(db));
    expect(sweep).toEqual({ claimed: 0, published: 0, failed: 0, skipped: 0 });

    // THE ASSERTION THIS FILE EXISTS FOR: the provider was not contacted.
    expect(plugin.publishAttempts()).toBe(attemptsBefore);
    const call = plugin.calls.find((c) => c.method === "publish");
    expect(call?.method === "publish" && call.outcome).toBe("reused");

    const row = db.tables.marketing_deliveries[0];
    expect(row.status).toBe("published");
    expect(row.external_ids).toEqual({
      container: "fake-container-entry-0",
      post: "fake-post-entry-0",
    });
    expect(row.error).toBeNull();
  });

  it("does publish a genuinely unpublished delivery on the second go", async () => {
    // The other half: a retry must still work when the first attempt really did
    // fail before reaching the provider.
    const db = createMarketingTestDb(seed());

    const first = await runMarketingDeliveries(asClient(db));
    expect(first.failed).toBe(1);

    // The inline publish is the second go; nothing waits for a sweep.
    await retryDelivery(asClient(db), "del-0");

    expect(plugin.publishAttempts()).toBe(2);
    expect(db.tables.marketing_deliveries[0].status).toBe("published");
  });
});
