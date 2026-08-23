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

    const returned = await retryDelivery(asClient(db), "del-0");

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

    await retryDelivery(asClient(db), "del-0");

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
      await expect(retryDelivery(asClient(db), "del-0")).rejects.toMatchObject({
        status: 409,
        message: `Only a delivery that failed can be retried, and this one is ${status}.`,
      });
      expect(db.tables.marketing_deliveries[0].status).toBe(status);
    }
  });

  it("answers 404 for a delivery that does not exist", async () => {
    const db = createMarketingTestDb(seed({ status: "failed" }));
    await expect(retryDelivery(asClient(db), "nope")).rejects.toBeInstanceOf(DeliveryRetryError);
    await expect(retryDelivery(asClient(db), "nope")).rejects.toMatchObject({ status: 404 });
  });

  it("lets only one of two simultaneous presses through", async () => {
    const db = createMarketingTestDb(seed({ status: "failed" }));

    const outcomes = await Promise.allSettled([
      retryDelivery(asClient(db), "del-0"),
      retryDelivery(asClient(db), "del-0"),
    ]);

    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);
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

    await retryDelivery(asClient(db), "del-0");
    const result = await runMarketingDeliveries(asClient(db));

    expect(result).toEqual({ claimed: 1, published: 1, failed: 0, skipped: 0 });

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

    await retryDelivery(asClient(db), "del-0");
    const second = await runMarketingDeliveries(asClient(db));

    expect(second.published).toBe(1);
    expect(plugin.publishAttempts()).toBe(2);
    expect(db.tables.marketing_deliveries[0].status).toBe("published");
  });
});
