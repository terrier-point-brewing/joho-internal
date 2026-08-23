/**
 * The fake is the instrument every later chip measures the chassis with, so
 * these tests are not really about the fake — they are about the contract it
 * demonstrates, and about the fake being trustworthy enough to demonstrate it.
 *
 * Two things get pinned hardest:
 *
 *  - **Idempotency.** A delivery carrying external ids must not be published a
 *    second time, and the call log must say so. This is the exact behaviour
 *    every real plugin is held to on retry, and the worker is tested against it.
 *  - **Determinism.** No clock, no randomness, no I/O. Two instances given the
 *    same inputs produce identical output, or every test downstream of this one
 *    inherits a coin flip.
 */
import { describe, it, expect } from "vitest";

import {
  createFakeChannelPlugin,
  FAKE_CAPTION_LIMIT,
  FAKE_CHANNEL,
  FAKE_TOKEN_EXPIRES_AT,
  type FakeCall,
} from "./index";
import type { ConnectedAccount, Entry, Media, PublishContext } from "../types";

function anEntry(over: Partial<Entry> = {}): Entry {
  return {
    id: "entry-1",
    kind: "post",
    startsAt: "2026-09-01T15:00:00.000Z",
    endsAt: null,
    caption: "Fresh cans of Epic Hazy, Friday at four.",
    details: {},
    status: "approved",
    origin: "manual",
    tags: ["cans"],
    ...over,
  };
}

function aMedia(over: Partial<Media> = {}): Media {
  return {
    id: "media-1",
    type: "image",
    url: "https://example.invalid/can.jpg",
    width: 1080,
    height: 1080,
    durationS: null,
    bytes: 240_000,
    ...over,
  };
}

function anAccount(over: Partial<ConnectedAccount> = {}): ConnectedAccount {
  return {
    id: "account-1",
    provider: "fake",
    channel: FAKE_CHANNEL,
    externalId: "fake-account-1",
    externalParentId: null,
    handle: "@fakebrewing",
    credentials: { accessToken: "fake-access-token-1" },
    tokenExpiresAt: FAKE_TOKEN_EXPIRES_AT,
    scopes: ["fake.publish"],
    ...over,
  };
}

function aContext(over: Partial<PublishContext> = {}): PublishContext {
  return {
    entry: anEntry(),
    media: [aMedia()],
    account: anAccount(),
    externalIds: {},
    ...over,
  };
}

const publishCalls = (calls: readonly FakeCall[]) => calls.filter((c) => c.method === "publish");

describe("fake channel plugin — identity", () => {
  it("registers under a fake channel and provider by default", () => {
    const fake = createFakeChannelPlugin();

    expect(fake.channel).toBe(FAKE_CHANNEL);
    expect(fake.provider).toBe("fake");
  });

  it("can be given its own channel key, so two instances can coexist", () => {
    const fake = createFakeChannelPlugin({ channel: "fake-two", provider: "acme" });

    expect(fake.channel).toBe("fake-two");
    expect(fake.provider).toBe("acme");
  });
});

describe("fake channel plugin — connect", () => {
  it("builds an auth URL that round-trips the CSRF state verbatim", () => {
    const fake = createFakeChannelPlugin();

    const url = fake.connect.authUrl("st/ate 1");

    expect(url).toContain("https://fake.marketing.invalid/oauth/authorize");
    expect(url).toContain(`state=${encodeURIComponent("st/ate 1")}`);
  });

  it("returns a storable account from the callback, with a fixed expiry rather than a clock reading", async () => {
    const fake = createFakeChannelPlugin();

    const account = await fake.connect.callback("code-abc", "state-xyz");

    expect(account).toEqual({
      provider: "fake",
      channel: FAKE_CHANNEL,
      externalId: "fake-account-code-abc",
      externalParentId: "fake-parent-code-abc",
      handle: "@fakebrewing",
      credentials: { accessToken: "fake-access-token-code-abc" },
      tokenExpiresAt: FAKE_TOKEN_EXPIRES_AT,
      scopes: ["fake.read", "fake.publish"],
    });
  });

  it("is deterministic — two instances, same inputs, identical output", async () => {
    const one = await createFakeChannelPlugin().connect.callback("code-abc", "state-xyz");
    const two = await createFakeChannelPlugin().connect.callback("code-abc", "state-xyz");

    expect(one).toEqual(two);
    expect(createFakeChannelPlugin().connect.authUrl("s")).toBe(createFakeChannelPlugin().connect.authUrl("s"));
  });
});

describe("fake channel plugin — validate", () => {
  it("accepts a post with a caption and an image", () => {
    const fake = createFakeChannelPlugin();

    expect(fake.validate(anEntry(), [aMedia()])).toEqual({ ok: true });
  });

  it("refuses a reel with no video, in a sentence a person can act on", () => {
    const fake = createFakeChannelPlugin();

    const result = fake.validate(anEntry({ kind: "reel" }), [aMedia({ type: "image" })]);

    expect(result).toEqual({ ok: false, reasons: ["A reel needs a video."] });
  });

  it("accepts a reel once it has a video", () => {
    const fake = createFakeChannelPlugin();
    const video = aMedia({ id: "media-2", type: "video", durationS: 20 });

    expect(fake.validate(anEntry({ kind: "reel" }), [video])).toEqual({ ok: true });
  });

  it("collects every reason at once rather than stopping at the first", () => {
    const fake = createFakeChannelPlugin();

    const result = fake.validate(anEntry({ kind: "reel", caption: "   " }), []);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons).toHaveLength(2);
    expect(result.reasons[0]).toBe("A reel needs a video.");
    expect(result.reasons[1]).toMatch(/caption or a piece of media/);
    // Reasons are sentences shown next to a disabled channel, not codes.
    result.reasons.forEach((r) => expect(r).toMatch(/\.$/));
  });

  it("treats a null caption as no caption — the column is nullable and a bare entry is refusable", () => {
    const fake = createFakeChannelPlugin();

    const result = fake.validate(anEntry({ caption: null }), []);

    expect(result).toEqual({
      ok: false,
      reasons: ["An entry needs either a caption or a piece of media before it can be posted."],
    });
  });

  it("refuses a caption past the channel's limit and says by how much", () => {
    const fake = createFakeChannelPlugin();
    const caption = "a".repeat(FAKE_CAPTION_LIMIT + 5);

    const result = fake.validate(anEntry({ caption }), [aMedia()]);

    expect(result).toEqual({
      ok: false,
      reasons: [`This caption is ${FAKE_CAPTION_LIMIT + 5} characters. The limit is ${FAKE_CAPTION_LIMIT}.`],
    });
  });

  it("takes an injected rule, so a test can force an answer without staging an entry", () => {
    const fake = createFakeChannelPlugin({
      validate: () => ({ ok: false, reasons: ["The account is not connected."] }),
    });

    expect(fake.validate(anEntry(), [aMedia()])).toEqual({
      ok: false,
      reasons: ["The account is not connected."],
    });
  });
});

describe("fake channel plugin — publish", () => {
  it("publishes and returns the ids the channel minted", async () => {
    const fake = createFakeChannelPlugin();

    const result = await fake.publish(aContext());

    expect(result.externalIds).toEqual({
      container: "fake-container-entry-1",
      post: "fake-post-entry-1",
    });
    expect(fake.publishAttempts()).toBe(1);
    expect(publishCalls(fake.calls)).toEqual([
      expect.objectContaining({ method: "publish", outcome: "published" }),
    ]);
  });

  it("rejects when the outcome is `fail`, and records the attempt", async () => {
    const fake = createFakeChannelPlugin({ outcome: "fail" });

    await expect(fake.publish(aContext())).rejects.toThrow(/failed to publish entry entry-1/);
    expect(fake.publishAttempts()).toBe(1);
    expect(publishCalls(fake.calls)).toEqual([expect.objectContaining({ outcome: "failed" })]);
  });

  it("fails once then succeeds under `succeed-after-retry`", async () => {
    const fake = createFakeChannelPlugin({ outcome: "succeed-after-retry" });

    await expect(fake.publish(aContext())).rejects.toThrow();
    const result = await fake.publish(aContext());

    expect(result.externalIds.post).toBe("fake-post-entry-1");
    expect(fake.publishAttempts()).toBe(2);
    expect(publishCalls(fake.calls).map((c) => c.outcome)).toEqual(["failed", "published"]);
  });

  it("can be flipped mid-flight, since the registered instance is only reachable through getChannel", async () => {
    const fake = createFakeChannelPlugin();
    expect(fake.getOutcome()).toBe("succeed");

    fake.setOutcome("fail");

    expect(fake.getOutcome()).toBe("fail");
    await expect(fake.publish(aContext())).rejects.toThrow();
  });

  it("keeps two instances entirely independent", async () => {
    const good = createFakeChannelPlugin({ channel: "good" });
    const bad = createFakeChannelPlugin({ channel: "bad", outcome: "fail" });

    await good.publish(aContext());

    expect(good.publishAttempts()).toBe(1);
    expect(bad.publishAttempts()).toBe(0);
    expect(bad.calls).toEqual([]);
  });
});

describe("fake channel plugin — idempotency", () => {
  const already = { container: "fake-container-entry-1", post: "fake-post-entry-1" };

  it("returns the delivery's existing ids without publishing again", async () => {
    const fake = createFakeChannelPlugin();

    const result = await fake.publish(aContext({ externalIds: already }));

    expect(result.externalIds).toEqual(already);
    // The attempt counter is the honest measure of "did it contact the provider".
    expect(fake.publishAttempts()).toBe(0);
    expect(publishCalls(fake.calls)).toEqual([expect.objectContaining({ outcome: "reused" })]);
  });

  it("hands back a copy, so a caller cannot mutate the delivery's stored ids", async () => {
    const fake = createFakeChannelPlugin();
    const ctx = aContext({ externalIds: already });

    const result = await fake.publish(ctx);

    expect(result.externalIds).not.toBe(ctx.externalIds);
    expect(ctx.externalIds).toEqual(already);
  });

  it("short-circuits even when the outcome says fail — the work is already done", async () => {
    const fake = createFakeChannelPlugin({ outcome: "fail" });

    const result = await fake.publish(aContext({ externalIds: already }));

    expect(result.externalIds).toEqual(already);
    expect(fake.publishAttempts()).toBe(0);
  });

  it("a retry after a successful publish publishes once and reuses thereafter", async () => {
    const fake = createFakeChannelPlugin();

    const first = await fake.publish(aContext());
    // The worker would have written these to marketing_deliveries.external_ids.
    const second = await fake.publish(aContext({ externalIds: first.externalIds }));

    expect(second.externalIds).toEqual(first.externalIds);
    expect(fake.publishAttempts()).toBe(1);
    expect(publishCalls(fake.calls).map((c) => c.outcome)).toEqual(["published", "reused"]);
  });

  it("treats an empty id map as not-yet-published", async () => {
    const fake = createFakeChannelPlugin();

    await fake.publish(aContext({ externalIds: {} }));

    expect(fake.publishAttempts()).toBe(1);
    expect(publishCalls(fake.calls).map((c) => c.outcome)).toEqual(["published"]);
  });
});

describe("fake channel plugin — the call recorder", () => {
  it("reports every method in order, with the arguments it was given", async () => {
    const fake = createFakeChannelPlugin();
    const entry = anEntry();
    const media = [aMedia(), aMedia({ id: "media-2" })];
    const ctx = aContext({ entry, media });

    fake.connect.authUrl("state-1");
    await fake.connect.callback("code-1", "state-1");
    fake.validate(entry, media);
    await fake.publish(ctx);

    expect(fake.calls.map((c) => c.method)).toEqual(["authUrl", "callback", "validate", "publish"]);

    const [auth, callback, validate, publish] = fake.calls;
    expect(auth).toMatchObject({ method: "authUrl", state: "state-1" });
    expect(callback).toMatchObject({ method: "callback", code: "code-1", state: "state-1" });
    // The arguments are kept whole, so a test can assert which media, in which order.
    expect(validate).toMatchObject({ method: "validate", entry, media, result: { ok: true } });
    expect(publish).toMatchObject({ method: "publish", ctx, outcome: "published" });
  });

  it("makes validate-before-publish provable", async () => {
    const fake = createFakeChannelPlugin();
    fake.validate(anEntry(), [aMedia()]);
    await fake.publish(aContext());

    const order = fake.calls.map((c) => c.method);

    expect(order.indexOf("validate")).toBeLessThan(order.indexOf("publish"));
  });

  it("clears its log and attempt counter on reset, keeping the outcome", async () => {
    const fake = createFakeChannelPlugin({ outcome: "succeed-after-retry" });
    await expect(fake.publish(aContext())).rejects.toThrow();

    fake.reset();

    expect(fake.calls).toEqual([]);
    expect(fake.publishAttempts()).toBe(0);
    expect(fake.getOutcome()).toBe("succeed-after-retry");
    // Reset rewinds the retry too: the next attempt is the first one again.
    await expect(fake.publish(aContext())).rejects.toThrow();
  });
});
