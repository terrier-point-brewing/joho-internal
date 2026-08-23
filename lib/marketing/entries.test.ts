/**
 * Creating an entry and reading a window of them.
 *
 * Three things here are worth more than the rest, and they are the three a
 * later bug could not repair:
 *
 *  1. **Media order.** Nothing in a row records which slide a person meant to
 *     be first. If the order is lost it is lost — so the assertions below use
 *     an order a naive query would silently re-sort, and check it twice: once
 *     as it comes back, and once against a second entry that uses the SAME
 *     media in a DIFFERENT order.
 *  2. **The statuses app code may write.** `draft` and `approved`, and nothing
 *     else. Everything past that belongs to the trigger, and an app that writes
 *     a derived status is a second author of one column.
 *  3. **Post now.** It must publish inline (the sweep is daily), and it must
 *     still succeed when that inline publish throws — the rows are already
 *     committed and the sweep will finish the job.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createEntry, getEntry, listEntries, parseCreateEntry, parseEntryWindow } from "./entries";
import { MarketingRequestError } from "./errors";
import { registerChannel } from "./plugins/registry";
import { createFakeChannelPlugin } from "./plugins/fake";
import { createMarketingTestDb, type MarketingTables, type Row } from "./__fixtures__/marketingDb";

const asClient = (db: { client: unknown }) => db.client as unknown as SupabaseClient;

const CHANNEL = "e-succeed";
const fake = createFakeChannelPlugin({ channel: CHANNEL });
registerChannel(fake);

/**
 * Three media whose ids sort in one order and whose intended order is another.
 * A query that forgot `order("position")` returns them by whatever the store
 * hands back — which for the fixture, and for Postgres without an ORDER BY, is
 * insertion order. Both of those are A, B, C. The caller asked for C, A, B.
 */
const MEDIA_A = "11111111-1111-4111-8111-111111111111";
const MEDIA_B = "22222222-2222-4222-8222-222222222222";
const MEDIA_C = "33333333-3333-4333-8333-333333333333";

function mediaRow(id: string, name: string): Row {
  return {
    id,
    type: "image",
    url: `https://example.invalid/${name}.jpg`,
    storage_path: `2026/08/${id}.jpg`,
    width: 1080,
    height: 1080,
    duration_s: null,
    bytes: 1234,
    tags: null,
  };
}

function seed(over: Partial<MarketingTables> = {}): Partial<MarketingTables> {
  return {
    marketing_media: [mediaRow(MEDIA_A, "a"), mediaRow(MEDIA_B, "b"), mediaRow(MEDIA_C, "c")],
    marketing_connected_accounts: [
      { id: "acc-1", provider: "fake", channel: CHANNEL, status: "connected", credentials: { token: "secret" } },
    ],
    ...over,
  };
}

beforeEach(() => {
  fake.reset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

// ── Parsing: what a caller may and may not ask for ──────────────────────────

describe("what the route will accept", () => {
  const base = { kind: "post", startsAt: "2026-08-24T13:00:00.000Z" };

  it("takes a plain draft", () => {
    expect(parseCreateEntry(base).status).toBeUndefined();
    expect(parseCreateEntry({ ...base, status: "draft" }).status).toBe("draft");
    expect(parseCreateEntry({ ...base, status: "approved" }).status).toBe("approved");
  });

  it.each(["scheduled", "in_progress", "done", "failed", "published", ""])(
    "refuses status %j, which is the trigger's to write",
    (status) => {
      expect(() => parseCreateEntry({ ...base, status })).toThrow(MarketingRequestError);
      expect(() => parseCreateEntry({ ...base, status })).toThrow(/may only be draft or approved/);
    },
  );

  it("refuses a future scheduled_at in either spelling — draft and now are the only options", () => {
    for (const body of [
      { ...base, scheduledAt: "2099-01-01T00:00:00.000Z" },
      { ...base, scheduled_at: "2099-01-01T00:00:00.000Z" },
    ]) {
      expect(() => parseCreateEntry(body)).toThrow(/Scheduling a post for later is not available/);
    }
  });

  it("refuses to be told an origin", () => {
    expect(() => parseCreateEntry({ ...base, origin: "assistant" })).toThrow(/origin is not settable/);
  });

  it("refuses channels without postNow, because a delivery would derive the entry's status", () => {
    expect(() => parseCreateEntry({ ...base, channels: [CHANNEL] })).toThrow(/only used when posting now/);
  });

  it("refuses postNow with nowhere to post", () => {
    expect(() => parseCreateEntry({ ...base, postNow: true })).toThrow(/at least one channel/);
  });

  it("refuses the same media twice", () => {
    expect(() => parseCreateEntry({ ...base, mediaIds: [MEDIA_A, MEDIA_A] })).toThrow(/listed twice/);
  });

  it("passes details through untouched", () => {
    const details = { firstComment: "🍺", nested: { boost: 12 } };
    expect(parseCreateEntry({ ...base, details }).details).toEqual(details);
  });
});

describe("the window", () => {
  it("is half-open: [from, to)", () => {
    const w = parseEntryWindow("2026-08-24T00:00:00.000Z", "2026-08-31T00:00:00.000Z");
    expect(w).toEqual({ fromIso: "2026-08-24T00:00:00.000Z", toIso: "2026-08-31T00:00:00.000Z" });
  });

  it("reads a bare date as midnight in the taproom, not in UTC", () => {
    // Eastern in August is UTC-4, so the 24th starts at 04:00Z.
    expect(parseEntryWindow("2026-08-24", "2026-08-31").fromIso).toBe("2026-08-24T04:00:00.000Z");
  });

  it("refuses a backwards or missing window", () => {
    expect(() => parseEntryWindow("2026-08-31", "2026-08-24")).toThrow(/earlier than/);
    expect(() => parseEntryWindow(null, "2026-08-31")).toThrow(/required/);
    expect(() => parseEntryWindow("last tuesday", "2026-08-31")).toThrow(/not a date I can read/);
  });
});

// ── Creating ────────────────────────────────────────────────────────────────

describe("creating an entry", () => {
  it("persists a text-only entry and reads it back with zero media", async () => {
    const db = createMarketingTestDb(seed());
    const entry = await createEntry(asClient(db), parseCreateEntry({ kind: "post", startsAt: "2026-08-24T13:00:00.000Z", caption: "Fresh." }));

    expect(entry.media).toEqual([]);
    expect(entry.deliveries).toEqual([]);
    expect(entry.status).toBe("draft");
    expect(entry.origin).toBe("manual");
    expect(db.tables.marketing_entry_media).toHaveLength(0);

    const readBack = await getEntry(asClient(db), entry.id);
    expect(readBack?.media).toEqual([]);
  });

  it("keeps the caller's media order exactly, including one a naive query would re-sort", async () => {
    const db = createMarketingTestDb(seed());
    // C first. Alphabetically and by insertion the store holds A, B, C.
    const wanted = [MEDIA_C, MEDIA_A, MEDIA_B];

    const entry = await createEntry(
      asClient(db),
      parseCreateEntry({ kind: "post", startsAt: "2026-08-24T13:00:00.000Z", mediaIds: wanted }),
    );

    // The order as returned, id by id — not a set, not a length.
    expect(entry.media.map((m) => m.id)).toEqual(wanted);
    // And the same order after a fresh read, which is the path the calendar
    // takes. If `order("position")` were dropped this is where it would show.
    expect((await getEntry(asClient(db), entry.id))!.media.map((m) => m.id)).toEqual(wanted);
    // The mechanism itself: position is the index in the array the caller sent.
    expect(
      db.tables.marketing_entry_media.map((r) => ({ media: r.media_id, position: r.position })),
    ).toEqual([
      { media: MEDIA_C, position: 0 },
      { media: MEDIA_A, position: 1 },
      { media: MEDIA_B, position: 2 },
    ]);
  });

  it("gives two entries their own order over the same three pieces of media", async () => {
    const db = createMarketingTestDb(seed());
    const first = [MEDIA_C, MEDIA_A, MEDIA_B];
    const second = [MEDIA_B, MEDIA_C, MEDIA_A];

    const a = await createEntry(asClient(db), parseCreateEntry({ kind: "post", startsAt: "2026-08-24T13:00:00.000Z", mediaIds: first }));
    const b = await createEntry(asClient(db), parseCreateEntry({ kind: "post", startsAt: "2026-08-25T13:00:00.000Z", mediaIds: second }));

    // Read through the LIST path, which loads both entries' media in one
    // statement — the exact query that would blur two orders into one.
    const window = parseEntryWindow("2026-08-24T00:00:00.000Z", "2026-08-26T00:00:00.000Z");
    const listed = await listEntries(asClient(db), window);
    const byId = new Map(listed.map((e) => [e.id, e.media.map((m) => m.id)]));

    expect(byId.get(a.id)).toEqual(first);
    expect(byId.get(b.id)).toEqual(second);
  });

  it("refuses media that does not exist, before writing anything", async () => {
    const db = createMarketingTestDb(seed());
    const missing = "44444444-4444-4444-8444-444444444444";
    await expect(
      createEntry(asClient(db), parseCreateEntry({ kind: "post", startsAt: "2026-08-24T13:00:00.000Z", mediaIds: [MEDIA_A, missing] })),
    ).rejects.toThrow(/No media exists with the id/);
    expect(db.tables.marketing_calendar_entries).toHaveLength(0);
    expect(db.tables.marketing_entry_media).toHaveLength(0);
  });

  it("writes only draft or approved — never a status the trigger owns", async () => {
    const db = createMarketingTestDb(seed());
    await createEntry(asClient(db), parseCreateEntry({ kind: "post", startsAt: "2026-08-24T13:00:00.000Z" }));
    await createEntry(asClient(db), parseCreateEntry({ kind: "post", startsAt: "2026-08-25T13:00:00.000Z", status: "approved" }));
    await createEntry(
      asClient(db),
      parseCreateEntry({ kind: "post", startsAt: "2026-08-26T13:00:00.000Z", postNow: true, channels: [CHANNEL] }),
      // The inline publish is not the subject here.
      { runWorker: async () => undefined },
    );

    const written = db.tables.marketing_calendar_entries.map((r) => r.status);
    expect(written).toEqual(["draft", "approved", "approved"]);
    for (const status of written) expect(["draft", "approved"]).toContain(status);
  });
});

// ── Post now ────────────────────────────────────────────────────────────────

describe("post now", () => {
  const body = { kind: "post", startsAt: "2026-08-24T13:00:00.000Z", caption: "Out now.", postNow: true, channels: [CHANNEL] };

  it("queues at now() and publishes inline, without waiting for the daily sweep", async () => {
    const db = createMarketingTestDb(seed());
    const before = Date.now();

    const entry = await createEntry(asClient(db), parseCreateEntry(body));

    // The fake actually contacted its "provider" — this is the assertion that
    // the worker ran in this request and not in some later one.
    const published = fake.calls.filter((c) => c.method === "publish" && c.outcome === "published");
    expect(published).toHaveLength(1);

    expect(entry.deliveries).toHaveLength(1);
    const delivery = entry.deliveries[0];
    expect(delivery.channel).toBe(CHANNEL);
    expect(delivery.status).toBe("published");
    expect(delivery.externalIds).toEqual({
      container: `fake-container-${entry.id}`,
      post: `fake-post-${entry.id}`,
    });

    // Queued at now(), not at some future time a caller chose.
    const scheduledAt = Date.parse(db.tables.marketing_deliveries[0].scheduled_at as string);
    expect(scheduledAt).toBeGreaterThanOrEqual(before);
    expect(scheduledAt).toBeLessThanOrEqual(Date.now());
  });

  it("still succeeds when the inline publish throws — the rows are committed and the sweep will finish", async () => {
    const db = createMarketingTestDb(seed());

    const entry = await createEntry(asClient(db), parseCreateEntry(body), {
      runWorker: async () => {
        throw new Error("the database fell over mid-claim");
      },
    });

    // The request succeeded…
    expect(entry.id).toBeTruthy();
    // …the entry and its delivery are on the calendar…
    expect(db.tables.marketing_calendar_entries).toHaveLength(1);
    expect(db.tables.marketing_deliveries).toHaveLength(1);
    // …and the delivery is exactly what the next sweep claims.
    expect(db.tables.marketing_deliveries[0].status).toBe("scheduled");
    expect(console.error).toHaveBeenCalled();
  });

  it("refuses a channel the registry does not know, without writing anything", async () => {
    const db = createMarketingTestDb(seed());
    await expect(
      createEntry(asClient(db), parseCreateEntry({ ...body, channels: ["tiktok"] })),
    ).rejects.toThrow(/no channel called "tiktok"/);
    expect(db.tables.marketing_calendar_entries).toHaveLength(0);
  });

  it("refuses a channel with no connected login", async () => {
    const db = createMarketingTestDb(seed({ marketing_connected_accounts: [] }));
    await expect(createEntry(asClient(db), parseCreateEntry(body))).rejects.toThrow(/Nothing is connected/);
    expect(db.tables.marketing_deliveries).toHaveLength(0);
  });

  it("refuses a channel whose login has been disconnected", async () => {
    const db = createMarketingTestDb(
      seed({
        marketing_connected_accounts: [
          { id: "acc-1", provider: "fake", channel: CHANNEL, status: "disconnected", credentials: {} },
        ],
      }),
    );
    await expect(createEntry(asClient(db), parseCreateEntry(body))).rejects.toThrow(/Nothing is connected/);
  });
});

// ── Reading a window ────────────────────────────────────────────────────────

describe("reading a week", () => {
  /** Monday 24 Aug 2026 through Monday 31 Aug, as UTC instants. */
  const window = { fromIso: "2026-08-24T00:00:00.000Z", toIso: "2026-08-31T00:00:00.000Z" };

  function calendar(): Partial<MarketingTables> {
    return seed({
      marketing_calendar_entries: [
        // Exactly on the open end — IN.
        { id: "on-from", kind: "post", starts_at: window.fromIso, ends_at: null, caption: "First", details: {}, status: "draft", origin: "manual", tags: [] },
        { id: "midweek", kind: "reel", starts_at: "2026-08-27T18:30:00.000Z", ends_at: null, caption: "Mid", details: {}, status: "approved", origin: "manual", tags: ["ipa"] },
        // Exactly on the closed end — OUT.
        { id: "on-to", kind: "post", starts_at: window.toIso, ends_at: null, caption: "Next week", details: {}, status: "draft", origin: "manual", tags: [] },
        // A millisecond before the end — IN.
        { id: "just-inside", kind: "post", starts_at: "2026-08-30T23:59:59.999Z", ends_at: null, caption: "Last", details: {}, status: "draft", origin: "manual", tags: [] },
        // A millisecond before the start — OUT.
        { id: "just-outside", kind: "post", starts_at: "2026-08-23T23:59:59.999Z", ends_at: null, caption: "Before", details: {}, status: "draft", origin: "manual", tags: [] },
      ],
      marketing_entry_media: [
        { entry_id: "midweek", media_id: MEDIA_C, position: 0 },
        { entry_id: "midweek", media_id: MEDIA_A, position: 1 },
        { entry_id: "midweek", media_id: MEDIA_B, position: 2 },
      ],
      marketing_deliveries: [
        {
          id: "del-1",
          entry_id: "midweek",
          account_id: "acc-1",
          channel: CHANNEL,
          scheduled_at: "2026-08-27T18:30:00.000Z",
          status: "failed",
          external_ids: {},
          error: "A reel needs a video.",
          attempt_count: 2,
          published_at: null,
        },
      ],
    });
  }

  it("includes an entry exactly at `from` and excludes one exactly at `to`", async () => {
    const db = createMarketingTestDb(calendar());
    const entries = await listEntries(asClient(db), window);
    expect(entries.map((e) => e.id)).toEqual(["on-from", "midweek", "just-inside"]);
  });

  it("hands back media in order and deliveries attached, in one call", async () => {
    const db = createMarketingTestDb(calendar());
    const entries = await listEntries(asClient(db), window);
    const midweek = entries.find((e) => e.id === "midweek")!;

    expect(midweek.media.map((m) => m.id)).toEqual([MEDIA_C, MEDIA_A, MEDIA_B]);
    expect(midweek.deliveries).toEqual([
      {
        id: "del-1",
        channel: CHANNEL,
        status: "failed",
        error: "A reel needs a video.",
        externalIds: {},
        scheduledAt: "2026-08-27T18:30:00.000Z",
        publishedAt: null,
        attemptCount: 2,
        accountId: "acc-1",
      },
    ]);
    // The entries with nothing on them say so, rather than being absent.
    expect(entries.find((e) => e.id === "on-from")!.media).toEqual([]);
    expect(entries.find((e) => e.id === "on-from")!.deliveries).toEqual([]);
  });

  it("says nothing at all for an empty week", async () => {
    const db = createMarketingTestDb(calendar());
    const entries = await listEntries(asClient(db), {
      fromIso: "2026-09-07T00:00:00.000Z",
      toIso: "2026-09-14T00:00:00.000Z",
    });
    expect(entries).toEqual([]);
  });
});

// ── The credential, which is not any of this module's business ──────────────

describe("credentials", () => {
  it("never appear in what an entry read hands back, even with a live token in the table", async () => {
    const db = createMarketingTestDb(seed());
    const entry = await createEntry(asClient(db), parseCreateEntry({ kind: "post", startsAt: "2026-08-24T13:00:00.000Z", postNow: true, channels: [CHANNEL] }));

    // The account row genuinely holds one (see `seed`), and the delivery
    // genuinely points at that account.
    expect(db.tables.marketing_connected_accounts[0].credentials).toEqual({ token: "secret" });
    expect(entry.deliveries[0].accountId).toBe("acc-1");

    // Everything the caller gets, serialised: no token, no `credentials` key.
    const body = JSON.stringify(entry);
    expect(body).not.toContain("secret");
    expect(body).not.toContain("credentials");
  });
});
