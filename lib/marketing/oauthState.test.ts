/**
 * The OAuth `state` token.
 *
 * Every test here is a refusal, because that is what the token is for: the
 * callback's only defence against a stranger's link is that a state it did not
 * issue, for a browser that did not start this, for a different channel, or
 * from ten minutes ago, is rejected outright. A token that verified in any of
 * those cases would be a token that verified for an attacker.
 */
import { describe, it, expect } from "vitest";

import { OAUTH_STATE_TTL_MS, createOAuthState, verifyOAuthState } from "./oauthState";

const SECRET = "test-signing-secret";
const NOW = Date.parse("2026-08-22T12:00:00.000Z");

const verify = (over: Partial<Parameters<typeof verifyOAuthState>[0]> = {}) =>
  verifyOAuthState({ state: null, cookie: null, channel: "fake", secret: SECRET, nowMs: NOW, ...over });

describe("a token this app just minted", () => {
  it("verifies when it comes back with its cookie", () => {
    const state = createOAuthState("fake", SECRET, NOW);
    expect(verify({ state, cookie: state })).toEqual({ ok: true });
  });

  it("is different every time, so two connects cannot be confused", () => {
    const a = createOAuthState("fake", SECRET, NOW);
    const b = createOAuthState("fake", SECRET, NOW);
    expect(a).not.toBe(b);
  });

  it("still verifies a second before it expires, and not a second after", () => {
    const state = createOAuthState("fake", SECRET, NOW);
    expect(verify({ state, cookie: state, nowMs: NOW + OAUTH_STATE_TTL_MS - 1000 }).ok).toBe(true);
    expect(verify({ state, cookie: state, nowMs: NOW + OAUTH_STATE_TTL_MS + 1000 }).ok).toBe(false);
  });
});

describe("everything that must be refused", () => {
  const state = createOAuthState("fake", SECRET, NOW);

  it("no state at all", () => {
    expect(verify({ cookie: state }).ok).toBe(false);
  });

  it("no cookie — this browser never started a connect", () => {
    const verdict = verify({ state });
    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ reason: expect.stringContaining("no record of starting this connect") });
  });

  it("a state that does not match the cookie", () => {
    const other = createOAuthState("fake", SECRET, NOW);
    expect(verify({ state, cookie: other }).ok).toBe(false);
  });

  it("a token this app did not sign, even when it matches the cookie", () => {
    // The attack the cookie comparison alone cannot see: a value planted in
    // both places by somebody who can write cookies for this host.
    const forged = createOAuthState("fake", "some-other-secret", NOW);
    const verdict = verify({ state: forged, cookie: forged });
    expect(verdict).toEqual({ ok: false, reason: "The state value was not issued by this app." });
  });

  it("a token whose payload was edited after signing", () => {
    const parts = createOAuthState("fake", SECRET, NOW).split(".");
    parts[2] = String(Number(parts[2]) + 60 * 60 * 1000); // a longer life than we granted
    const tampered = parts.join(".");
    expect(verify({ state: tampered, cookie: tampered }).ok).toBe(false);
  });

  it("a token minted for a different channel", () => {
    const forFacebook = createOAuthState("facebook", SECRET, NOW);
    const verdict = verify({ state: forFacebook, cookie: forFacebook, channel: "instagram" });
    expect(verdict).toEqual({ ok: false, reason: "The state value was issued for a different channel." });
  });

  it("something that is not one of our tokens at all", () => {
    expect(verify({ state: "hello", cookie: "hello" }).ok).toBe(false);
    expect(verify({ state: "", cookie: "" }).ok).toBe(false);
  });
});
