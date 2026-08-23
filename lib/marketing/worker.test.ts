/**
 * The publishing worker, and the one bug it exists to make impossible: posting
 * the same thing twice.
 *
 * The concurrency block below is the centre of this file. Everything else —
 * fail-fast validation, the failure path, the idempotent retry — is a
 * consequence of the same rule: a publish you are not certain about must never
 * be repeated by a machine.
 *
 * Channels are registered here under their own keys rather than mocked, so
 * these tests go through the real `getChannel` the worker uses. The fake
 * plugin's call log is the evidence: `published` means it contacted its
 * "provider", `reused` means it recognised already-published work and did not.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { runMarketingDeliveries } from "./worker";
import { registerChannel } from "./plugins/registry";
import { createFakeChannelPlugin, type FakeChannelPlugin } from "./plugins/fake";
import {
  createMarketingTestDb,
  testAccount,
  testDelivery,
  testEntry,
  type MarketingTables,
  type Row,
} from "./__fixtures__/marketingDb";

const asClient = (db: { client: unknown }) => db.client as unknown as SupabaseClient;

// One fake per behaviour, each under its own channel key, all registered once.
// Registering the same key twice throws by design, so they cannot be created
// per-test.
const succeeds = createFakeChannelPlugin({ channel: "t-succeed" });
const fails = createFakeChannelPlugin({ channel: "t-fail", outcome: "fail" });
const refuses = createFakeChannelPlugin({
  channel: "t-refuse",
  validate: () => ({ ok: false, reasons: ["A reel needs a video.", "This caption is too long."] }),
});
for (const p of [succeeds, fails, refuses]) registerChannel(p);

beforeEach(() => {
  for (const p of [succeeds, fails, refuses]) p.reset();
  // The worker writes one structured line per delivery; 100 of them would bury
  // a failing assertion.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** `n` due deliveries on `n` entries, all through one channel. */
function seedDue(n: number, channel: string): Partial<MarketingTables> {
  return {
    marketing_connected_accounts: [testAccount(channel)],
    marketing_calendar_entries: Array.from({ length: n }, (_, i) => testEntry(`entry-${i}`)),
    marketing_deliveries: Array.from({ length: n }, (_, i) => testDelivery(`del-${i}`, `entry-${i}`, channel)),
  };
}

/** Every delivery the fake actually contacted its provider for. */
function publishedEntryIds(plugin: FakeChannelPlugin): string[] {
  return plugin.calls
    .filter((c): c is Extract<typeof c, { method: "publish" }> => c.method === "publish")
    .filter((c) => c.outcome === "published")
    .map((c) => c.ctx.entry.id);
}

// ── The claim ───────────────────────────────────────────────────────────────

describe("two workers running at once", () => {
  it("publishes 100 due deliveries exactly 100 times, with no delivery published twice", async () => {
    const db = createMarketingTestDb(seedDue(100, "t-succeed"));

    // Genuinely concurrent: both invocations are in flight together, and the
    // fixture yields a macrotask before every statement, so they interleave at
    // every await either of them makes.
    const [a, b] = await Promise.all([
      runMarketingDeliveries(asClient(db)),
      runMarketingDeliveries(asClient(db)),
    ]);

    // The claim itself: every row went to exactly one of the two runs.
    expect(a.claimed + b.claimed).toBe(100);

    // The thing that cannot be taken back: the provider was contacted 100
    // times, for 100 distinct entries.
    const published = publishedEntryIds(succeeds);
    expect(published).toHaveLength(100);
    expect(new Set(published).size).toBe(100);

    // And nothing was left stranded mid-flight.
    expect(a.published + b.published).toBe(100);
    expect(db.tables.marketing_deliveries.every((d) => d.status === "published")).toBe(true);
  });

  it("would catch a select-then-update claim — the fixture has teeth", async () => {
    // This is the control. If the fixture resolved queries synchronously, the
    // test above would pass no matter how the claim were written, and would
    // therefore prove nothing. So: run the WRONG claim against the same
    // fixture and show that it double-publishes.
    const db = createMarketingTestDb(seedDue(20, "t-succeed"));
    const client = asClient(db) as unknown as ReturnType<typeof createMarketingTestDb>["client"];

    async function claimTheWrongWay(): Promise<Row[]> {
      // Two statements with a window between them — the bug this file exists
      // to make impossible.
      const { data: found } = await client
        .from("marketing_deliveries")
        .select("id")
        .eq("status", "scheduled");
      const claimed: Row[] = [];
      for (const row of found ?? []) {
        const { data } = await client
          .from("marketing_deliveries")
          .update({ status: "publishing" })
          .eq("id", row.id)
          .select("id");
        claimed.push(...(data ?? []));
      }
      return claimed;
    }

    const [x, y] = await Promise.all([claimTheWrongWay(), claimTheWrongWay()]);
    const ids = [...x, ...y].map((r) => r.id);

    // Both runs claimed all 20 rows: 40 claims for 20 deliveries. Under the
    // real claim this is 20.
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size).toBe(20);
  });

  it("leaves a delivery whose time has not come alone", async () => {
    const seed = seedDue(1, "t-succeed");
    seed.marketing_deliveries![0].scheduled_at = "2099-01-01T00:00:00.000Z";
    const db = createMarketingTestDb(seed);

    const result = await runMarketingDeliveries(asClient(db));

    expect(result).toEqual({ claimed: 0, published: 0, failed: 0, skipped: 0 });
    expect(db.tables.marketing_deliveries[0].status).toBe("scheduled");
    expect(succeeds.publishAttempts()).toBe(0);
  });

  it("never claims a delivery that is not scheduled", async () => {
    // pending, publishing, published, failed and skipped are all invisible to
    // the claim. A failed one in particular must stay failed until a person acts.
    const seed = seedDue(5, "t-succeed");
    const statuses = ["pending", "publishing", "published", "failed", "skipped"];
    seed.marketing_deliveries!.forEach((d, i) => (d.status = statuses[i]));
    const db = createMarketingTestDb(seed);

    const result = await runMarketingDeliveries(asClient(db));

    expect(result.claimed).toBe(0);
    expect(db.tables.marketing_deliveries.map((d) => d.status)).toEqual(statuses);
  });
});

// ── Publishing one delivery ─────────────────────────────────────────────────

describe("a delivery that publishes", () => {
  it("records the provider's ids, the time, and clears the last failure", async () => {
    const seed = seedDue(1, "t-succeed");
    seed.marketing_deliveries![0].error = "it went wrong last Tuesday";
    seed.marketing_deliveries![0].attempt_count = 2;
    const db = createMarketingTestDb(seed);

    const result = await runMarketingDeliveries(asClient(db));

    expect(result).toEqual({ claimed: 1, published: 1, failed: 0, skipped: 0 });
    const row = db.tables.marketing_deliveries[0];
    expect(row.status).toBe("published");
    expect(row.external_ids).toEqual({
      container: "fake-container-entry-0",
      post: "fake-post-entry-0",
    });
    expect(row.published_at).toEqual(expect.any(String));
    expect(row.error).toBeNull();
    // attempt_count counts failures, and this was not one.
    expect(row.attempt_count).toBe(2);
  });

  it("hands the plugin its media in position order", async () => {
    const seed = seedDue(1, "t-succeed");
    seed.marketing_media = [
      { id: "m-a", type: "image", url: "https://x/a.jpg", width: 1, height: 1, duration_s: null, bytes: 10 },
      { id: "m-b", type: "image", url: "https://x/b.jpg", width: 1, height: 1, duration_s: null, bytes: 20 },
      { id: "m-c", type: "video", url: "https://x/c.mp4", width: 1, height: 1, duration_s: 30, bytes: 30 },
    ];
    // Seeded out of order on purpose — a carousel published in the wrong order
    // is a post that has to be deleted.
    seed.marketing_entry_media = [
      { entry_id: "entry-0", media_id: "m-c", position: 2 },
      { entry_id: "entry-0", media_id: "m-a", position: 0 },
      { entry_id: "entry-0", media_id: "m-b", position: 1 },
    ];
    const db = createMarketingTestDb(seed);

    await runMarketingDeliveries(asClient(db));

    const call = succeeds.calls.find((c) => c.method === "publish");
    expect(call?.method === "publish" && call.ctx.media.map((m) => m.id)).toEqual(["m-a", "m-b", "m-c"]);
    // numeric duration_s arrives as a number, not a string.
    expect(call?.method === "publish" && call.ctx.media[2].durationS).toBe(30);
  });
});

// ── Failing fast, and failing safely ────────────────────────────────────────

describe("a delivery that fails", () => {
  it("leaves it failed, with a readable error and one more attempt counted", async () => {
    const db = createMarketingTestDb(seedDue(1, "t-fail"));

    const result = await runMarketingDeliveries(asClient(db));

    expect(result).toEqual({ claimed: 1, published: 0, failed: 1, skipped: 0 });
    const row = db.tables.marketing_deliveries[0];
    expect(row.status).toBe("failed");
    expect(row.error).toContain("failed to publish");
    expect(row.attempt_count).toBe(1);
    // Nothing was published, so there is nothing to record.
    expect(row.external_ids).toEqual({});
    expect(row.published_at).toBeNull();
  });

  it("does not retry it, in the same run or the next one", async () => {
    const db = createMarketingTestDb(seedDue(1, "t-fail"));

    await runMarketingDeliveries(asClient(db));
    const second = await runMarketingDeliveries(asClient(db));

    expect(second.claimed).toBe(0);
    expect(fails.publishAttempts()).toBe(1);
    expect(db.tables.marketing_deliveries[0].attempt_count).toBe(1);
  });

  it("carries on with the rest of the batch", async () => {
    const seed = seedDue(3, "t-fail");
    // The middle one goes through a channel that works.
    seed.marketing_deliveries![1].channel = "t-succeed";
    seed.marketing_connected_accounts!.push(testAccount("t-succeed", "acc-2"));
    seed.marketing_deliveries![1].account_id = "acc-2";
    const db = createMarketingTestDb(seed);

    const result = await runMarketingDeliveries(asClient(db));

    expect(result).toEqual({ claimed: 3, published: 1, failed: 2, skipped: 0 });
    expect(db.tables.marketing_deliveries.map((d) => d.status)).toEqual(["failed", "published", "failed"]);
  });

  it("never lets a credential reach the error it records", async () => {
    const db = createMarketingTestDb(seedDue(1, "t-fail"));

    await runMarketingDeliveries(asClient(db));

    expect(String(db.tables.marketing_deliveries[0].error)).not.toContain("super-secret-token");
  });
});

describe("validation", () => {
  it("short-circuits: publish is never called when validate says no", async () => {
    const db = createMarketingTestDb(seedDue(1, "t-refuse"));

    const result = await runMarketingDeliveries(asClient(db));

    expect(result).toEqual({ claimed: 1, published: 0, failed: 1, skipped: 0 });
    // The whole point. Not "publish was called and rejected" — not called at all.
    expect(refuses.calls.some((c) => c.method === "publish")).toBe(false);
    expect(refuses.publishAttempts()).toBe(0);
    expect(refuses.calls.filter((c) => c.method === "validate")).toHaveLength(1);
  });

  it("records the reasons as the sentences a person will read", async () => {
    const db = createMarketingTestDb(seedDue(1, "t-refuse"));

    await runMarketingDeliveries(asClient(db));

    expect(db.tables.marketing_deliveries[0].error).toBe(
      "A reel needs a video. This caption is too long.",
    );
    expect(db.tables.marketing_deliveries[0].attempt_count).toBe(1);
  });
});

describe("a channel nothing is registered under", () => {
  it("fails the delivery with a sentence rather than throwing out of the batch", async () => {
    // Production ships with an EMPTY registry, so this is the ordinary state
    // and not a "should never happen".
    const seed = seedDue(2, "t-succeed");
    seed.marketing_deliveries![0].channel = "instagram";
    const db = createMarketingTestDb(seed);

    const result = await runMarketingDeliveries(asClient(db));

    expect(result).toEqual({ claimed: 2, published: 1, failed: 1, skipped: 0 });
    expect(db.tables.marketing_deliveries[0].status).toBe("failed");
    expect(String(db.tables.marketing_deliveries[0].error)).toContain("instagram");
  });
});

describe("a delivery whose channel login is gone", () => {
  it("is skipped, not failed — there is no credential and no retry that invents one", async () => {
    const seed = seedDue(1, "t-succeed");
    // `on delete set null`: this is the shape a person disconnecting a channel
    // leaves behind.
    seed.marketing_deliveries![0].account_id = null;
    const db = createMarketingTestDb(seed);

    const result = await runMarketingDeliveries(asClient(db));

    expect(result).toEqual({ claimed: 1, published: 0, failed: 0, skipped: 1 });
    expect(db.tables.marketing_deliveries[0].status).toBe("skipped");
    expect(succeeds.publishAttempts()).toBe(0);
  });
});

// ── Idempotency ─────────────────────────────────────────────────────────────

describe("re-running the job", () => {
  // This is `lib/cron/reRunSafety.test.ts`'s question, asked here because the
  // marketing boundary keeps that file from importing this one. See the
  // marketing-deliveries note at the foot of it.
  it("leaves every delivery a person has already dealt with exactly as it is", async () => {
    const statuses = ["pending", "publishing", "published", "failed", "skipped"];
    const seed = seedDue(5, "t-succeed");
    seed.marketing_deliveries!.forEach((d, i) => {
      d.status = statuses[i];
      if (statuses[i] === "failed") {
        d.error = "a person is looking at this";
        d.attempt_count = 4;
      }
    });
    const db = createMarketingTestDb(seed);
    const before = JSON.stringify(db.tables.marketing_deliveries);

    const result = await runMarketingDeliveries(asClient(db));
    await runMarketingDeliveries(asClient(db));

    expect(result).toEqual({ claimed: 0, published: 0, failed: 0, skipped: 0 });
    expect(JSON.stringify(db.tables.marketing_deliveries)).toBe(before);
    expect(succeeds.publishAttempts()).toBe(0);
  });
});

describe("a delivery that already carries external ids", () => {
  it("is recognised as done and is not published again", async () => {
    const seed = seedDue(1, "t-succeed");
    seed.marketing_deliveries![0].external_ids = { post: "fake-post-entry-0" };
    seed.marketing_deliveries![0].status = "scheduled";
    const db = createMarketingTestDb(seed);

    const result = await runMarketingDeliveries(asClient(db));

    expect(result.published).toBe(1);
    // The proof: the fake logged a `reused`, and its attempt counter never moved.
    const call = succeeds.calls.find((c) => c.method === "publish");
    expect(call?.method === "publish" && call.outcome).toBe("reused");
    expect(succeeds.publishAttempts()).toBe(0);
    expect(db.tables.marketing_deliveries[0].external_ids).toEqual({ post: "fake-post-entry-0" });
  });
});
