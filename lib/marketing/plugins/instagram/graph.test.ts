/**
 * The transport, against a stubbed `fetch`.
 *
 * Two things are worth pinning here and the rest is plumbing:
 *
 *  - **`outcomeUnknown`.** It is the flag `publish` branches on to decide
 *    whether a post might exist, so getting it backwards is how a delivery gets
 *    published twice.
 *  - **A 200 carrying an `error` envelope is a failure.** Meta signals refusal
 *    both ways, and treating an error body as a successful publish would store
 *    ids for a post that never happened.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

import { GRAPH_VERSION, GraphError, createGraphTransport, requireString } from "./graph";

/** Stand in for the platform fetch, returning one scripted response. */
function stubFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => new Response(body === null ? "" : JSON.stringify(body), { status })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("graph transport", () => {
  it("puts a GET's parameters in the query and the token in a bearer header", async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ id: "1" }), { status: 200 }));
    vi.stubGlobal("fetch", spy);

    await createGraphTransport().request({ method: "GET", path: "17841/media", token: "tok", params: { fields: "id" } });

    const [url, init] = spy.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(`https://graph.facebook.com/${GRAPH_VERSION}/17841/media?fields=id`);
    expect(url.toString()).not.toContain("tok");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(init.body).toBeUndefined();
  });

  it("puts a POST's parameters in a form body, never in the URL", async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ id: "1" }), { status: 200 }));
    vi.stubGlobal("fetch", spy);

    await createGraphTransport().request({
      method: "POST",
      path: "oauth/access_token",
      params: { client_secret: "shh", code: "abc" },
    });

    const [url, init] = spy.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
    expect(url.toString()).not.toContain("shh");
    expect(init.body).toBe("client_secret=shh&code=abc");
  });

  it("returns the body on success", async () => {
    vi.stubGlobal("fetch", stubFetch(200, { id: "container-1" }));
    await expect(createGraphTransport().request({ method: "POST", path: "x" })).resolves.toEqual({ id: "container-1" });
  });

  it("quotes Meta's own message and code on a refusal", async () => {
    vi.stubGlobal("fetch", stubFetch(400, { error: { message: "Invalid parameter", code: 100, error_subcode: 2207009, type: "OAuthException" } }));

    await expect(createGraphTransport().request({ method: "POST", path: "x" })).rejects.toMatchObject({
      message: "Invalid parameter (Meta code 100)",
      code: 100,
      status: 400,
    });
  });

  it("treats a 200 carrying an error envelope as a failure", async () => {
    vi.stubGlobal("fetch", stubFetch(200, { error: { message: "Application request limit reached", code: 4 } }));

    await expect(createGraphTransport().request({ method: "POST", path: "x" })).rejects.toThrow(/request limit reached/);
  });

  it("says so when the answer is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>502</html>", { status: 502 })));

    await expect(createGraphTransport().request({ method: "GET", path: "x" })).rejects.toThrow(/not JSON/);
  });

  it("reports an unreachable Instagram without naming the URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNRESET");
    }));

    const err = await createGraphTransport()
      .request({ method: "POST", path: "17841/media_publish", token: "tok" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GraphError);
    expect((err as GraphError).message).toContain("ECONNRESET");
    expect((err as GraphError).message).not.toContain("17841");
    expect((err as GraphError).status).toBeNull();
  });
});

describe("outcomeUnknown — the flag publish branches on", () => {
  it("is false for a 4xx: Meta said it did not do the thing", () => {
    expect(new GraphError("no", { status: 400 }).outcomeUnknown).toBe(false);
    expect(new GraphError("no", { status: 403 }).outcomeUnknown).toBe(false);
  });

  it("is true for a 5xx: Meta said nothing useful", () => {
    expect(new GraphError("no", { status: 500 }).outcomeUnknown).toBe(true);
    expect(new GraphError("no", { status: 503 }).outcomeUnknown).toBe(true);
  });

  it("is true when there was no answer at all", () => {
    expect(new GraphError("no", { status: null }).outcomeUnknown).toBe(true);
  });
});

describe("requireString", () => {
  it("returns the field when it is there", () => {
    expect(requireString({ id: "abc" }, "id", "a call")).toBe("abc");
  });

  it("names the call and the field when it is not", () => {
    expect(() => requireString({}, "id", "the request to publish the post")).toThrow(
      /the request to publish the post did not include an? "id"/,
    );
  });

  it("refuses an empty string as an id", () => {
    expect(() => requireString({ id: "" }, "id", "a call")).toThrow(/did not include/);
  });
});
