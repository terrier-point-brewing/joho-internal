/**
 * The stated-balance override: an operator restating a month's figure on an
 * account whose method only ever relays a position somebody else keeps.
 *
 * The behaviours worth protecting are not the arithmetic -- they are the four
 * places this could quietly go wrong: overriding an account it should not,
 * failing to override one it should, summing to the wrong total once stored,
 * and starting to chase every bank account for a monthly figure.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  __resetMethodRegistry,
  registerMethod,
  runMethod,
  acceptsStatedBalance,
  STATED_BALANCE_KEY,
} from "./registry";
import { __resetRegistry, registerProvider } from "../registry";
import type { BalanceContext, BalanceProvider } from "../registry";

/** A provider that reports a position someone else keeps. */
function feedProvider(key: string, cents: number | null): BalanceProvider {
  return { key, label: key, kind: "integration", pointInTime: true, compute: async () => cents };
}

/** A provider that accumulates from movements this system recorded. */
function accumulatingProvider(key: string, cents: number | null): BalanceProvider {
  return { key, label: key, kind: "derived", compute: async () => cents };
}

function step(providerKey: string) {
  return { providerKey, label: providerKey, description: "d", source: "s", direction: "net" as const };
}

/** Supabase stub answering only the stated-balance lookup. */
function stubSupabase(statedCents: number | null): BalanceContext["supabase"] {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: statedCents === null ? null : { amount_cents: statedCents }, error: null }),
  };
  return { from: () => chain } as unknown as BalanceContext["supabase"];
}

function ctx(statedCents: number | null): BalanceContext {
  return { supabase: stubSupabase(statedCents), periodEnd: "2026-05-31", coaId: "coa-1", config: {} };
}

describe("acceptsStatedBalance", () => {
  beforeEach(() => { __resetRegistry(); __resetMethodRegistry(); });
  afterEach(() => { __resetRegistry(); __resetMethodRegistry(); });

  it("accepts a method whose every step reports a kept position", () => {
    registerProvider(feedProvider("feed", 100));
    const m = { key: "m", label: "m", kind: "calculation" as const, summary: "s", steps: [step("feed")] };
    registerMethod(m);
    expect(acceptsStatedBalance(m)).toBe(true);
  });

  it("refuses a method with an accumulating step", () => {
    // The important refusal. Overriding one month of an accumulating account
    // fixes that month and lets the error return the next -- which looks fixed
    // and is not. Such an account is corrected with a transaction entry instead.
    registerProvider(feedProvider("feed", 100));
    registerProvider(accumulatingProvider("postings", 5));
    const m = { key: "m", label: "m", kind: "calculation" as const, summary: "s", steps: [step("feed"), step("postings")] };
    registerMethod(m);
    expect(acceptsStatedBalance(m)).toBe(false);
  });

  it("refuses a method that already reads a stated balance", () => {
    // Otherwise the figure lands twice: once through the method's own step and
    // once through the override.
    registerProvider({ key: "manualish", label: "m", kind: "manual", compute: async () => 7 });
    const m = { key: "m", label: "m", kind: "manual" as const, summary: "s", steps: [step("manualish")] };
    registerMethod(m);
    expect(acceptsStatedBalance(m)).toBe(false);
  });

  it("refuses rather than throws when a step names an unregistered provider", () => {
    const m = { key: "m", label: "m", kind: "calculation" as const, summary: "s", steps: [step("nope")] };
    registerMethod(m);
    expect(acceptsStatedBalance(m)).toBe(false);
  });
});

describe("runMethod with a stated balance", () => {
  beforeEach(() => { __resetRegistry(); __resetMethodRegistry(); });
  afterEach(() => { __resetRegistry(); __resetMethodRegistry(); });

  function feedMethod(computed: number | null) {
    registerProvider(feedProvider("feed", computed));
    const m = { key: "m", label: "m", kind: "calculation" as const, summary: "s", steps: [step("feed")] };
    registerMethod(m);
    return m;
  }

  it("reports the stated figure, not the computed one", async () => {
    const outcome = await runMethod(feedMethod(500_000), ctx(480_000));
    expect(outcome).toMatchObject({ status: "ok", cents: 480_000 });
  });

  it("records the override as the DIFFERENCE so contributions still sum to the balance", async () => {
    // Contributions are summed to produce the stored balance (see
    // resolveSnapshotWrites). Storing the stated figure beside the computed one
    // would total both and report roughly double.
    const outcome = await runMethod(feedMethod(500_000), ctx(480_000));
    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.breakdown).toEqual({ feed: 500_000, [STATED_BALANCE_KEY]: -20_000 });
    const summed = Object.values(outcome.breakdown).reduce((a, b) => a + b, 0);
    expect(summed).toBe(outcome.cents);
  });

  it("gives a month the feed never answered a figure at all", async () => {
    // The case worth having: nothing was captured that day, so the account read
    // as unsourced with no way to ever fill it in.
    const outcome = await runMethod(feedMethod(null), ctx(480_000));
    expect(outcome).toMatchObject({ status: "ok", cents: 480_000 });
    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.breakdown).toEqual({ [STATED_BALANCE_KEY]: 480_000 });
  });

  it("leaves the computed figure alone when nobody stated one", async () => {
    const outcome = await runMethod(feedMethod(500_000), ctx(null));
    expect(outcome).toMatchObject({ status: "ok", cents: 500_000 });
    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.breakdown).toEqual({ feed: 500_000 });
  });

  it("still reads empty when neither the feed nor an operator has an answer", async () => {
    const outcome = await runMethod(feedMethod(null), ctx(null));
    expect(outcome.status).toBe("empty");
  });

  it("never overrides a FAILED method", async () => {
    // "The integration broke" and "the operator restated the figure" are
    // different situations. Papering over the first with the second would retire
    // the only signal that the integration is broken, and would publish a stated
    // figure while the account's real source is silently dead.
    registerProvider({
      key: "feed", label: "feed", kind: "integration", pointInTime: true,
      compute: async () => { throw new Error("bank unreachable"); },
    });
    const m = { key: "m", label: "m", kind: "calculation" as const, summary: "s", steps: [step("feed")] };
    registerMethod(m);
    const outcome = await runMethod(m, ctx(480_000));
    expect(outcome.status).toBe("failed");
  });

  it("does not touch an accumulating method even when a balance is stated", async () => {
    registerProvider(accumulatingProvider("postings", 300_000));
    const m = { key: "m", label: "m", kind: "calculation" as const, summary: "s", steps: [step("postings")] };
    registerMethod(m);
    const outcome = await runMethod(m, ctx(999_999));
    expect(outcome).toMatchObject({ status: "ok", cents: 300_000 });
  });
});

// Assertions about the methods as SHIPPED live in definitions.test.ts, which
// keeps the real registry intact. They cannot run here: the blocks above reset
// both registries, so by this point getProvider answers nothing.
