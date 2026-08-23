/**
 * Instagram, driven by a stubbed transport.
 *
 * **Nothing here touches the network, and that is the point.** Every test below
 * hands the plugin a `GraphTransport` that records what it was asked for and
 * answers from a script, so the assertions are about the exact sequence of Graph
 * calls the plugin makes — which is the only thing that can post twice.
 *
 * The three that matter most, in order of how bad the bug would be:
 *
 *  1. **A delivery carrying external ids makes zero calls.** Not "the right
 *     calls" — zero. This is the assertion the whole chassis was arranged
 *     around, and the one a live retry has to reproduce.
 *  2. **A `media_publish` whose answer never arrived does not become a second
 *     post.** The plugin asks the container what happened; `PUBLISHED` means the
 *     delivery succeeded.
 *  3. **Nothing after a successful publish can throw the publish away.** A
 *     permalink lookup that fails leaves a published delivery, not a failed one
 *     that a person will retry into a duplicate.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

import { createInstagramChannelPlugin, INSTAGRAM_CHANNEL, INSTAGRAM_REDIRECT_URI, INSTAGRAM_SCOPES } from "./index";
import { GRAPH_VERSION, GraphError, type GraphRequest, type GraphTransport } from "./graph";
import type { ConnectedAccount, Entry, Media, PublishContext } from "../types";

// ── The stub ────────────────────────────────────────────────────────────────

/** One scripted answer: either a body to return or an error to throw. */
type Answer = Record<string, unknown> | Error;

interface Stub extends GraphTransport {
  readonly calls: readonly GraphRequest[];
}

/**
 * A transport that answers in order and remembers everything it was asked.
 *
 * In order rather than by path, because the ORDER is what these tests are
 * about: a carousel published with its children out of sequence is a post that
 * has to be deleted, and "the plugin called `media_publish` before it made a
 * container" is exactly the shape of bug a path-keyed stub hides.
 */
function stubTransport(answers: Answer[]): Stub {
  const calls: GraphRequest[] = [];
  let index = 0;
  return {
    calls,
    async request(req: GraphRequest): Promise<Record<string, unknown>> {
      calls.push(req);
      const answer = answers[index++];
      if (answer === undefined) throw new Error(`stub: unexpected call ${index} to ${req.path}`);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

/** A transport that fails if it is contacted at all. */
function forbiddenTransport(): Stub {
  const calls: GraphRequest[] = [];
  return {
    calls,
    async request(req: GraphRequest): Promise<Record<string, unknown>> {
      calls.push(req);
      throw new Error(`the plugin contacted Instagram (${req.method} ${req.path}) when it must not have`);
    },
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const IG_USER_ID = "17841400000000000";
const PAGE_ID = "1029384756";

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

function anImage(over: Partial<Media> = {}): Media {
  return {
    id: "media-1",
    type: "image",
    url: "https://bucket.invalid/marketing-media/2026/09/one.jpg",
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
    provider: "meta",
    channel: INSTAGRAM_CHANNEL,
    externalId: IG_USER_ID,
    externalParentId: PAGE_ID,
    handle: "@johobrewing",
    credentials: { pageAccessToken: "page-token", userAccessToken: "user-token", pageId: PAGE_ID, igUserId: IG_USER_ID },
    tokenExpiresAt: "2026-10-22T00:00:00.000Z",
    scopes: [...INSTAGRAM_SCOPES],
    ...over,
  };
}

function aContext(over: Partial<PublishContext> = {}): PublishContext {
  return {
    entry: anEntry(),
    media: [anImage()],
    account: anAccount(),
    externalIds: {},
    ...over,
  };
}

/** A 500 from Meta: the request may or may not have landed. */
function serverError(): GraphError {
  return new GraphError("Instagram is having a moment. (Meta code 2)", { code: 2, status: 500 });
}

/** A 400 from Meta: it definitely did not do the thing. */
function refusal(message = "The image is not a supported format. (Meta code 100)"): GraphError {
  return new GraphError(message, { code: 100, status: 400 });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── Identity ────────────────────────────────────────────────────────────────

describe("instagram plugin identity", () => {
  it("registers under exactly the key Meta's redirect URI was registered against", () => {
    // Strict Mode is on at Meta and the URI is matched byte for byte. If this
    // ever disagrees, connecting fails with an error that does not mention it.
    expect(INSTAGRAM_CHANNEL).toBe("instagram");
    expect(INSTAGRAM_REDIRECT_URI).toBe("https://internal.johobrewing.com/api/marketing/accounts/callback/instagram");
    expect(INSTAGRAM_REDIRECT_URI.endsWith(`/${INSTAGRAM_CHANNEL}`)).toBe(true);
  });

  it("names meta as the provider, because Facebook will share it", () => {
    expect(createInstagramChannelPlugin().provider).toBe("meta");
  });

  it("asks for the three permissions the app was configured with, and no more", () => {
    expect(INSTAGRAM_SCOPES).toEqual([
      "instagram_basic",
      "instagram_content_publish",
      "pages_read_engagement",
      // Without this, GET /me/accounts answers with an empty list and connect
      // fails at the Page lookup. Configuring it on the Meta app is not enough:
      // the dialog only requests what this list names.
      "pages_show_list",
    ]);
  });
});

// ── connect.authUrl ─────────────────────────────────────────────────────────

describe("instagram connect — the dialog", () => {
  it("builds the Facebook OAuth dialog and round-trips state verbatim", () => {
    vi.stubEnv("META_APP_ID", "app-123");
    const url = new URL(createInstagramChannelPlugin().connect.authUrl("v1.aGk.123.abc.sig"));

    expect(url.origin + url.pathname).toBe(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
    expect(url.searchParams.get("client_id")).toBe("app-123");
    expect(url.searchParams.get("redirect_uri")).toBe(INSTAGRAM_REDIRECT_URI);
    expect(url.searchParams.get("state")).toBe("v1.aGk.123.abc.sig");
    expect(url.searchParams.get("scope")).toBe(
      "instagram_basic,instagram_content_publish,pages_read_engagement,pages_show_list",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("refuses in a sentence when META_APP_ID is not set", () => {
    vi.stubEnv("META_APP_ID", "");
    expect(() => createInstagramChannelPlugin().connect.authUrl("s")).toThrow(/META_APP_ID/);
    expect(() => createInstagramChannelPlugin().connect.authUrl("s")).toThrow(/Settings → Basic/);
  });
});

// ── connect.callback ────────────────────────────────────────────────────────

/** The happy three-call script: code → short token → long token → page. */
function connectAnswers(over: { expiresIn?: number; pages?: unknown[] } = {}): Answer[] {
  return [
    { access_token: "short-token" },
    { access_token: "long-user-token", expires_in: over.expiresIn ?? 5_184_000 },
    {
      data: over.pages ?? [
        {
          id: PAGE_ID,
          name: "Joho Brewing",
          access_token: "page-token",
          instagram_business_account: { id: IG_USER_ID, username: "johobrewing" },
        },
      ],
    },
  ];
}

describe("instagram connect — the callback", () => {
  it("exchanges the code, then the token, then resolves the page", async () => {
    vi.stubEnv("META_APP_ID", "app-123");
    vi.stubEnv("META_APP_SECRET", "secret-456");
    const transport = stubTransport(connectAnswers());

    const account = await createInstagramChannelPlugin({ transport }).connect.callback("the-code", "the-state");

    expect(transport.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST oauth/access_token",
      "POST oauth/access_token",
      "GET me/accounts",
    ]);
    // The code exchange must carry the same redirect_uri, byte for byte.
    expect(transport.calls[0].params).toMatchObject({
      client_id: "app-123",
      client_secret: "secret-456",
      redirect_uri: INSTAGRAM_REDIRECT_URI,
      code: "the-code",
    });
    expect(transport.calls[1].params).toMatchObject({ grant_type: "fb_exchange_token", fb_exchange_token: "short-token" });
    expect(account.externalId).toBe(IG_USER_ID);
    expect(account.externalParentId).toBe(PAGE_ID);
    expect(account.handle).toBe("@johobrewing");
    expect(account.provider).toBe("meta");
    expect(account.channel).toBe("instagram");
    expect(account.scopes).toEqual(INSTAGRAM_SCOPES);
  });

  it("stores the page token as the one that publishes, and the user token beside it", async () => {
    vi.stubEnv("META_APP_ID", "app-123");
    vi.stubEnv("META_APP_SECRET", "secret-456");
    const account = await createInstagramChannelPlugin({ transport: stubTransport(connectAnswers()) }).connect.callback(
      "c",
      "s",
    );

    // The page token does not expire; the user token does. Publishing uses the
    // one that does not, which is why day 61 is uneventful.
    expect(account.credentials.pageAccessToken).toBe("page-token");
    expect(account.credentials.userAccessToken).toBe("long-user-token");
  });

  it("records the user token's expiry, because that is what token_expires_at means", async () => {
    vi.stubEnv("META_APP_ID", "app-123");
    vi.stubEnv("META_APP_SECRET", "secret-456");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));
    try {
      const account = await createInstagramChannelPlugin({
        transport: stubTransport(connectAnswers({ expiresIn: 60 * 60 * 24 * 60 })),
      }).connect.callback("c", "s");
      expect(account.tokenExpiresAt).toBe("2026-10-22T12:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the expiry null when Meta issues a token without one", async () => {
    vi.stubEnv("META_APP_ID", "app-123");
    vi.stubEnv("META_APP_SECRET", "secret-456");
    const answers = connectAnswers();
    answers[1] = { access_token: "long-user-token" };
    const account = await createInstagramChannelPlugin({ transport: stubTransport(answers) }).connect.callback("c", "s");

    expect(account.tokenExpiresAt).toBeNull();
  });

  it("names the missing permission when Meta lists no pages at all", async () => {
    vi.stubEnv("META_APP_ID", "app-123");
    vi.stubEnv("META_APP_SECRET", "secret-456");
    const transport = stubTransport(connectAnswers({ pages: [] }));

    await expect(createInstagramChannelPlugin({ transport }).connect.callback("c", "s")).rejects.toThrow(
      /pages_show_list/,
    );
  });

  it("says to link the account when a page has no Instagram behind it", async () => {
    vi.stubEnv("META_APP_ID", "app-123");
    vi.stubEnv("META_APP_SECRET", "secret-456");
    const transport = stubTransport(
      connectAnswers({ pages: [{ id: PAGE_ID, name: "Joho Brewing", access_token: "t", instagram_business_account: null }] }),
    );

    await expect(createInstagramChannelPlugin({ transport }).connect.callback("c", "s")).rejects.toThrow(
      /Meta Business Suite/,
    );
  });

  it("refuses to guess when two pages both have Instagram accounts", async () => {
    vi.stubEnv("META_APP_ID", "app-123");
    vi.stubEnv("META_APP_SECRET", "secret-456");
    const page = (id: string, name: string) => ({
      id,
      name,
      access_token: `token-${id}`,
      instagram_business_account: { id: `ig-${id}`, username: name },
    });
    const transport = stubTransport(connectAnswers({ pages: [page("1", "Joho Brewing"), page("2", "Joho Taproom")] }));

    await expect(createInstagramChannelPlugin({ transport }).connect.callback("c", "s")).rejects.toThrow(
      /Joho Brewing, Joho Taproom/,
    );
  });

  it("refuses in a sentence when META_APP_SECRET is not set, without calling anything", async () => {
    vi.stubEnv("META_APP_ID", "app-123");
    vi.stubEnv("META_APP_SECRET", "");
    const transport = forbiddenTransport();

    await expect(createInstagramChannelPlugin({ transport }).connect.callback("c", "s")).rejects.toThrow(
      /META_APP_SECRET/,
    );
    expect(transport.calls).toHaveLength(0);
  });
});

// ── publish: idempotency ────────────────────────────────────────────────────

describe("instagram publish — idempotency, the assertion the chassis was arranged around", () => {
  it("returns the existing ids and contacts Instagram zero times", async () => {
    const transport = forbiddenTransport();
    const externalIds = { container: "c-1", media: "m-1", permalink: "https://www.instagram.com/p/ABC/" };

    const result = await createInstagramChannelPlugin({ transport }).publish(aContext({ externalIds }));

    expect(result.externalIds).toEqual(externalIds);
    expect(transport.calls).toHaveLength(0);
  });

  it("is idempotent on a single id, not just a full bag", async () => {
    const transport = forbiddenTransport();
    const result = await createInstagramChannelPlugin({ transport }).publish(aContext({ externalIds: { container: "c-1" } }));

    expect(result.externalIds).toEqual({ container: "c-1" });
    expect(transport.calls).toHaveLength(0);
  });

  it("does not even read the credential before deciding it is done", async () => {
    // A delivery whose account was later unlinked, retried by a person: the
    // ids are the answer, and a missing token must not turn a published
    // delivery into a failed one.
    const transport = forbiddenTransport();
    const account = anAccount({ credentials: {} });

    const result = await createInstagramChannelPlugin({ transport }).publish(
      aContext({ account, externalIds: { media: "m-1" } }),
    );

    expect(result.externalIds).toEqual({ media: "m-1" });
    expect(transport.calls).toHaveLength(0);
  });

  it("returns a copy, so a caller cannot mutate the delivery's own bag", async () => {
    const externalIds = { media: "m-1" };
    const result = await createInstagramChannelPlugin({ transport: forbiddenTransport() }).publish(aContext({ externalIds }));

    expect(result.externalIds).not.toBe(externalIds);
  });
});

// ── publish: a single image ─────────────────────────────────────────────────

describe("instagram publish — one image", () => {
  it("creates a container, publishes it, and returns every id including the permalink", async () => {
    const transport = stubTransport([
      { id: "container-1" },
      { id: "media-1" },
      { permalink: "https://www.instagram.com/p/ABC/" },
    ]);

    const result = await createInstagramChannelPlugin({ transport }).publish(aContext());

    expect(transport.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST ${IG_USER_ID}/media`,
      `POST ${IG_USER_ID}/media_publish`,
      "GET media-1",
    ]);
    expect(transport.calls[0].params).toEqual({
      image_url: "https://bucket.invalid/marketing-media/2026/09/one.jpg",
      caption: "Fresh cans of Epic Hazy, Friday at four.",
    });
    expect(transport.calls[1].params).toEqual({ creation_id: "container-1" });
    expect(result.externalIds).toEqual({
      container: "container-1",
      media: "media-1",
      permalink: "https://www.instagram.com/p/ABC/",
    });
  });

  it("sends the page token as a bearer credential on every call", async () => {
    const transport = stubTransport([{ id: "c" }, { id: "m" }, { permalink: "https://p/" }]);
    await createInstagramChannelPlugin({ transport }).publish(aContext());

    for (const call of transport.calls) expect(call.token).toBe("page-token");
    // And never in a query parameter, where it would end up in somebody's log.
    for (const call of transport.calls) expect(JSON.stringify(call.params ?? {})).not.toContain("page-token");
  });

  it("posts an empty caption rather than omitting it, for a caption-less entry", async () => {
    const transport = stubTransport([{ id: "c" }, { id: "m" }, { permalink: "https://p/" }]);
    await createInstagramChannelPlugin({ transport }).publish(aContext({ entry: anEntry({ caption: null }) }));

    expect(transport.calls[0].params).toMatchObject({ caption: "" });
  });
});

// ── publish: a carousel ─────────────────────────────────────────────────────

describe("instagram publish — a carousel", () => {
  it("creates one container per image in order, then a parent, then publishes", async () => {
    const media = [
      anImage({ id: "a", url: "https://b.invalid/1.jpg" }),
      anImage({ id: "b", url: "https://b.invalid/2.jpg" }),
      anImage({ id: "c", url: "https://b.invalid/3.jpg" }),
    ];
    const transport = stubTransport([
      { id: "child-1" },
      { id: "child-2" },
      { id: "child-3" },
      { id: "parent-1" },
      { id: "media-9" },
      { permalink: "https://www.instagram.com/p/XYZ/" },
    ]);

    const result = await createInstagramChannelPlugin({ transport }).publish(aContext({ media }));

    // The order is the order Compose showed. A carousel published out of
    // sequence is a post that has to be deleted.
    expect(transport.calls.slice(0, 3).map((c) => c.params?.image_url)).toEqual([
      "https://b.invalid/1.jpg",
      "https://b.invalid/2.jpg",
      "https://b.invalid/3.jpg",
    ]);
    for (const call of transport.calls.slice(0, 3)) {
      expect(call.params).toMatchObject({ is_carousel_item: "true" });
      // The caption belongs on the parent, not on each child.
      expect(call.params?.caption).toBeUndefined();
    }
    expect(transport.calls[3].params).toEqual({
      media_type: "CAROUSEL",
      children: "child-1,child-2,child-3",
      caption: "Fresh cans of Epic Hazy, Friday at four.",
    });
    expect(transport.calls[4].params).toEqual({ creation_id: "parent-1" });
    expect(result.externalIds).toEqual({
      "item-1": "child-1",
      "item-2": "child-2",
      "item-3": "child-3",
      container: "parent-1",
      media: "media-9",
      permalink: "https://www.instagram.com/p/XYZ/",
    });
  });

  it("stops at the first child that fails, having posted nothing", async () => {
    const media = [anImage({ id: "a" }), anImage({ id: "b" }), anImage({ id: "c" })];
    const transport = stubTransport([{ id: "child-1" }, refusal("That image is too small. (Meta code 100)")]);

    await expect(createInstagramChannelPlugin({ transport }).publish(aContext({ media }))).rejects.toThrow(/too small/);

    // Two calls, neither of them media_publish. The orphaned container expires
    // by itself in 24 hours and a retry starts clean.
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls.some((c) => c.path.endsWith("media_publish"))).toBe(false);
  });
});

// ── publish: failure, and the window between the two steps ──────────────────

describe("instagram publish — failure", () => {
  it("fails without publishing when the container cannot be created", async () => {
    const transport = stubTransport([refusal()]);

    await expect(createInstagramChannelPlugin({ transport }).publish(aContext())).rejects.toThrow(/not a supported format/);
    expect(transport.calls).toHaveLength(1);
  });

  it("fails cleanly when Meta refuses the publish outright — nothing was posted", async () => {
    const transport = stubTransport([{ id: "container-1" }, refusal("Media ID is not available. (Meta code 9007)")]);

    await expect(createInstagramChannelPlugin({ transport }).publish(aContext())).rejects.toThrow(/not available/);
    // A 400 is Meta saying it did not do the thing, so there is nothing to
    // check and no recovery read is made.
    expect(transport.calls).toHaveLength(2);
  });

  it("treats a lost answer as a published post when the container says PUBLISHED", async () => {
    // The dangerous window: the request may have landed. Asking the container
    // is the only thing that can tell us, and a published delivery is what
    // stops a person's retry from posting a second time.
    const transport = stubTransport([{ id: "container-1" }, serverError(), { status_code: "PUBLISHED" }]);

    const result = await createInstagramChannelPlugin({ transport }).publish(aContext());

    expect(result.externalIds).toEqual({ container: "container-1", container_status: "PUBLISHED" });
    expect(transport.calls[2]).toMatchObject({ method: "GET", path: "container-1", params: { fields: "status_code" } });
  });

  it("does not invent a media id it could not recover", async () => {
    const transport = stubTransport([{ id: "container-1" }, serverError(), { status_code: "PUBLISHED" }]);
    const result = await createInstagramChannelPlugin({ transport }).publish(aContext());

    expect(result.externalIds.media).toBeUndefined();
    expect(result.externalIds.permalink).toBeUndefined();
  });

  it("recovers a carousel's item ids too, so a retry sees a non-empty bag", async () => {
    const media = [anImage({ id: "a" }), anImage({ id: "b" })];
    const transport = stubTransport([
      { id: "child-1" },
      { id: "child-2" },
      { id: "parent-1" },
      serverError(),
      { status_code: "PUBLISHED" },
    ]);

    const result = await createInstagramChannelPlugin({ transport }).publish(aContext({ media }));

    expect(result.externalIds).toEqual({
      "item-1": "child-1",
      "item-2": "child-2",
      container: "parent-1",
      container_status: "PUBLISHED",
    });
  });

  it("fails, and says nothing was published, when the container is only FINISHED", async () => {
    const transport = stubTransport([{ id: "container-1" }, serverError(), { status_code: "FINISHED" }]);

    await expect(createInstagramChannelPlugin({ transport }).publish(aContext())).rejects.toThrow(
      /reports the prepared post as FINISHED, so nothing was published/,
    );
  });

  it("says the outcome is unknown when even the recovery read fails", async () => {
    const transport = stubTransport([{ id: "container-1" }, serverError(), new Error("still down")]);

    await expect(createInstagramChannelPlugin({ transport }).publish(aContext())).rejects.toThrow(
      /could not confirm whether the post went out — check the account before retrying/,
    );
  });

  it("keeps the delivery published when only the permalink lookup fails", async () => {
    // Nothing after media_publish may throw the publish away. A retry with an
    // empty bag would post a second time.
    const transport = stubTransport([{ id: "container-1" }, { id: "media-1" }, new Error("permalink lookup died")]);

    const result = await createInstagramChannelPlugin({ transport }).publish(aContext());

    expect(result.externalIds).toEqual({ container: "container-1", media: "media-1" });
  });

  it("omits a permalink Meta returned as something other than a string", async () => {
    const transport = stubTransport([{ id: "container-1" }, { id: "media-1" }, { permalink: null }]);
    const result = await createInstagramChannelPlugin({ transport }).publish(aContext());

    expect(result.externalIds).toEqual({ container: "container-1", media: "media-1" });
  });

  it("refuses to publish an account with no stored page token, without calling anything", async () => {
    const transport = forbiddenTransport();
    const account = anAccount({ credentials: { userAccessToken: "u" } });

    await expect(createInstagramChannelPlugin({ transport }).publish(aContext({ account }))).rejects.toThrow(
      /Reconnect it from Settings → Marketing/,
    );
    expect(transport.calls).toHaveLength(0);
  });

  it("refuses an entry with no media rather than asking Meta to", async () => {
    const transport = forbiddenTransport();

    await expect(createInstagramChannelPlugin({ transport }).publish(aContext({ media: [] }))).rejects.toThrow(
      /nothing to post to Instagram/,
    );
    expect(transport.calls).toHaveLength(0);
  });
});

// ── Secrets ─────────────────────────────────────────────────────────────────

describe("instagram plugin — secrets stay out of what anybody can read", () => {
  it("never puts the token in an error message", async () => {
    const transport = stubTransport([refusal("nope")]);

    await expect(createInstagramChannelPlugin({ transport }).publish(aContext())).rejects.toThrow(
      expect.not.stringContaining("page-token") as unknown as string,
    );
  });

  it("never puts the app secret in the dialog URL", () => {
    vi.stubEnv("META_APP_ID", "app-123");
    vi.stubEnv("META_APP_SECRET", "secret-456");

    expect(createInstagramChannelPlugin().connect.authUrl("s")).not.toContain("secret-456");
  });
});
