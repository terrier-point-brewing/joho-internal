/**
 * The OAuth `state` token, and where it lives between the two halves of a
 * connect.
 *
 * `state` is the only thing standing between "a person connected our Instagram"
 * and "somebody else's account got connected to our brewery by a link they sent
 * us". The provider hands it back verbatim, and the callback's job is to
 * satisfy itself that the value came from a connect WE started, in THIS
 * browser, recently, for THIS channel.
 *
 * ── Where it is stored ──────────────────────────────────────────────────────
 * In a short-lived, httpOnly, SameSite=Lax cookie, and nowhere else. **There is
 * deliberately no table.** A row would be a schema change this chip does not
 * own, and — more to the point — it would be the wrong shape: the fact being
 * remembered belongs to one browser for ten minutes, which is exactly what a
 * cookie is. Nothing here needs to survive a deploy, be read by another
 * request, or be audited afterwards.
 *
 * ── Why it is signed as well as compared ────────────────────────────────────
 * The cookie comparison alone (a classic double-submit) already defeats the
 * ordinary attack: an attacker cannot read or predict a random value they never
 * saw. The HMAC is the second lock, and it earns its place because the first
 * one has a known weakness — cookies are writable across subdomains and by a
 * network attacker on any plain-http sibling, so "the cookie says so" is not by
 * itself proof that WE minted the value. A signature is: a planted token that
 * this server never signed fails verification even when it matches the cookie
 * an attacker planted alongside it.
 *
 * The token also carries its own expiry and its own channel, so a stale token,
 * or one minted for a different channel, is refused on its contents rather than
 * on the cookie's `Max-Age` (which a client controls) or on the URL (which the
 * caller controls).
 *
 * Everything in this module is pure: it takes a secret and a clock as
 * arguments and performs no I/O, so the routes stay thin and the rules above
 * are testable without a browser.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The cookie the connect route sets and the callback route consumes.
 *
 * Scoped by name rather than by channel: a person connects one channel at a
 * time, and a second connect started in another tab SHOULD invalidate the
 * first — two half-finished OAuth dances in one browser is not a workflow
 * worth supporting, and pretending otherwise means keeping more secrets around
 * for longer.
 */
export const OAUTH_STATE_COOKIE = "marketing_oauth_state";

/**
 * How long a mint is good for. Ten minutes is long enough for a person to log
 * in at a provider and pick an account, and short enough that a token lifted
 * from a browser's cookie jar is usually already dead.
 */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** Anything the token cannot be trusted about. Sentences, for the same reason plugin reasons are. */
export type OAuthStateVerdict = { ok: true } | { ok: false; reason: string };

const VERSION = "v1";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Constant-time string compare that tolerates unequal lengths (timingSafeEqual throws on those). */
function sameSecretly(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Mint a state token for one channel.
 *
 * The nonce is what makes two mints for the same channel in the same
 * millisecond different tokens; the signature is over everything, so none of
 * the three parts can be edited in flight.
 */
export function createOAuthState(
  channel: string,
  secret: string,
  nowMs: number = Date.now(),
  nonce: string = randomBytes(16).toString("hex"),
): string {
  const payload = `${VERSION}.${b64url(channel)}.${nowMs + OAUTH_STATE_TTL_MS}.${nonce}`;
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Decide whether a callback's `state` may be trusted.
 *
 * Every check is a refusal, and the order is cheapest-first — but note that
 * NONE of them is skippable: a token that matches the cookie but is unsigned is
 * as unacceptable as one that is signed but does not match the cookie.
 */
export function verifyOAuthState(args: {
  /** The `state` query parameter the provider handed back. */
  state: string | null | undefined;
  /** The value of {@link OAUTH_STATE_COOKIE} on this request. */
  cookie: string | null | undefined;
  /** The channel whose callback route this is. */
  channel: string;
  secret: string;
  nowMs?: number;
}): OAuthStateVerdict {
  const { state, cookie, channel, secret, nowMs = Date.now() } = args;

  if (!state) return { ok: false, reason: "The provider did not send a state value back, so this connect cannot be trusted." };
  if (!cookie) {
    return {
      ok: false,
      reason: "This browser has no record of starting this connect. Start it again from the Accounts screen.",
    };
  }
  if (!sameSecretly(state, cookie)) {
    return {
      ok: false,
      reason: "The state value does not match the connect this browser started, so it was rejected.",
    };
  }

  const parts = state.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION) {
    return { ok: false, reason: "The state value is not in a form this app issues." };
  }
  const [, channelB64, expRaw, , signature] = parts;
  const payload = parts.slice(0, 4).join(".");

  if (!sameSecretly(signature, sign(payload, secret))) {
    return { ok: false, reason: "The state value was not issued by this app." };
  }

  const expiresAt = Number(expRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    return { ok: false, reason: "This connect took too long and expired. Start it again from the Accounts screen." };
  }

  if (Buffer.from(channelB64, "base64url").toString() !== channel) {
    return { ok: false, reason: "The state value was issued for a different channel." };
  }

  return { ok: true };
}

/**
 * The signing secret, or a refusal a route can turn into an error a person can act on.
 *
 * Read from the environment at call time rather than at import time, the way
 * `lib/env` does, so a missing variable surfaces on the request that needed it
 * instead of at boot. It is its own variable rather than a reuse of
 * `CRON_SECRET` or the service-role key: a signing key that appears in two
 * unrelated protocols is a key you cannot rotate.
 */
export function oauthStateSecret(): string {
  const secret = process.env.MARKETING_OAUTH_STATE_SECRET;
  if (!secret) {
    throw new Error(
      "Connecting a channel needs MARKETING_OAUTH_STATE_SECRET set (generate one with: openssl rand -hex 32).",
    );
  }
  return secret;
}
