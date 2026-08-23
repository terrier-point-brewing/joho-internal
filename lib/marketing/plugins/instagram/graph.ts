/**
 * The Meta Graph API, as this plugin talks to it.
 *
 * One transport, one error type, and the two things that are easy to get wrong
 * with Meta's API kept in one place so the plugin itself reads as a sequence of
 * business steps rather than a sequence of HTTP.
 *
 * ── The token never goes in a URL ───────────────────────────────────────────
 * Graph accepts `access_token` as a query parameter and every Meta example uses
 * it that way. This module does not. A token in a query string ends up in
 * whatever logs a URL — a proxy, a fetch trace, an error message that happened
 * to include the request — and `marketing_connected_accounts.credentials` exists
 * precisely so that never happens. Graph also accepts
 * `Authorization: Bearer <token>`, so that is what is used, and the OAuth
 * exchanges (which carry the app secret rather than a user token) go as POST
 * bodies for the same reason.
 *
 * **Nothing in this module logs, and no error it raises contains a token, a
 * secret, or a request URL.** A Graph error message is quoted, because Meta
 * writes them for developers and they are the only useful thing about a
 * failure; nothing is added to it from our side except the code.
 *
 * ── The transport is injectable ─────────────────────────────────────────────
 * `createInstagramChannelPlugin({ transport })` is how the tests drive this
 * without a network, and it is the only reason this is an interface rather than
 * a function. There is no second production implementation and there should not
 * be one.
 */

/**
 * The Graph version every call is pinned to.
 *
 * Pinned rather than tracking "latest" because an unpinned version changes the
 * behaviour of a publish without anybody deploying anything. v25.0 was released
 * 2026-02-18 and expires 2028-07-29 — old enough to be settled, far enough out
 * that this does not need touching for two years. Moving it is a deliberate act
 * with a re-run of the live checks, not a dependency bump.
 */
export const GRAPH_VERSION = "v25.0";

/** Graph's host. The OAuth *dialog* lives on www.facebook.com; everything else is here. */
export const GRAPH_HOST = "https://graph.facebook.com";

/** The OAuth dialog a person is sent to. Not an API call — a browser redirect. */
export const OAUTH_DIALOG_HOST = "https://www.facebook.com";

/** One Graph request. `token` absent means an unauthenticated OAuth exchange. */
export interface GraphRequest {
  method: "GET" | "POST";
  /** Path after the version, e.g. `17841400000000000/media`. No leading slash. */
  path: string;
  /** A user or page access token, sent as a bearer header. Never as a query parameter. */
  token?: string;
  /** Query parameters (GET) or form fields (POST). */
  params?: Record<string, string>;
}

/** What the plugin needs from the outside world, and nothing more. */
export interface GraphTransport {
  request(req: GraphRequest): Promise<Record<string, unknown>>;
}

/**
 * A refusal from Meta.
 *
 * Two fields, and each one is read by something. `status` decides whether a
 * failed publish might nonetheless have posted, which is the whole reason this
 * class exists rather than a plain `Error`. `code` is Meta's own — the only
 * stable handle on *why*, since the message text changes between versions — and
 * it is what a later "your token died, reconnect" path will branch on.
 * `error_subcode` and `type` are deliberately not kept: they would be two more
 * fields nothing reads, and Meta's message already carries what they say.
 */
export class GraphError extends Error {
  /** Meta's `error.code`, or null when the failure was not one of Meta's. */
  readonly code: number | null;
  /** HTTP status, or null when the request never got an answer at all. */
  readonly status: number | null;

  constructor(message: string, parts: { code?: number | null; status?: number | null } = {}) {
    super(message);
    this.name = "GraphError";
    this.code = parts.code ?? null;
    this.status = parts.status ?? null;
  }

  /**
   * Whether this failure leaves the outcome of the request genuinely unknown.
   *
   * A 400 with an error code is Meta telling us it did not do the thing. A
   * timeout, a 5xx, or a socket that died is Meta telling us nothing, and the
   * request may well have landed. `publish` treats the two completely
   * differently, because one of them can mean a post exists.
   */
  get outcomeUnknown(): boolean {
    if (this.status === null) return true; // never got an answer
    return this.status >= 500;
  }
}

/** Meta's `{ error: { … } }` envelope, as far as we read it. */
interface GraphErrorBody {
  message?: unknown;
  code?: unknown;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * Turn whatever came back into either a body or a `GraphError`.
 *
 * Meta signals failure two ways — a non-2xx status, and a 200 carrying an
 * `error` object — and both have to be caught here or a caller ends up treating
 * an error envelope as a successful publish.
 */
function interpret(status: number, body: unknown): Record<string, unknown> {
  const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const err = record.error as GraphErrorBody | undefined;

  if (status >= 200 && status < 300 && !err) return record;

  const code = asNumber(err?.code);
  const message = asString(err?.message) ?? `Instagram returned HTTP ${status} with no explanation.`;
  throw new GraphError(code === null ? message : `${message} (Meta code ${code})`, { code, status });
}

/**
 * The real transport. Uses the platform `fetch`; no client library, in keeping
 * with every other outside integration in this repo.
 */
export function createGraphTransport(): GraphTransport {
  return {
    async request({ method, path, token, params }: GraphRequest): Promise<Record<string, unknown>> {
      const url = new URL(`${GRAPH_HOST}/${GRAPH_VERSION}/${path}`);
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;

      let body: string | undefined;
      if (method === "GET") {
        for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
      } else {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        body = new URLSearchParams(params ?? {}).toString();
      }

      let res: Response;
      try {
        res = await fetch(url, { method, headers, body, cache: "no-store" });
      } catch (cause) {
        // No answer at all. The message deliberately does not include the URL:
        // a GET's URL is harmless, but one habit is easier to keep than two.
        throw new GraphError(
          `Instagram could not be reached (${cause instanceof Error ? cause.message : "network error"}).`,
          { status: null },
        );
      }

      let parsed: unknown = null;
      const text = await res.text();
      if (text !== "") {
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new GraphError(`Instagram sent back something that was not JSON (HTTP ${res.status}).`, {
            status: res.status,
          });
        }
      }
      return interpret(res.status, parsed);
    },
  };
}

/** Read a string field off a Graph response, or say which call was malformed. */
export function requireString(body: Record<string, unknown>, field: string, what: string): string {
  const value = body[field];
  if (typeof value !== "string" || value === "") {
    throw new GraphError(`Instagram's reply to ${what} did not include a "${field}".`, { status: null });
  }
  return value;
}
