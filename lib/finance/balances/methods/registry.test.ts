import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerMethod,
  getMethod,
  listMethods,
  methodsFor,
  runMethod,
  stepKey,
  __resetMethodRegistry,
  type BalanceMethod,
} from "./registry";
import { registerProvider, __resetRegistry, type BalanceProvider } from "../registry";
import type { BalanceContext } from "../registry";
import type { CoaAccountRef } from "../../financials/types";

const ctx = { supabase: {}, periodEnd: "2026-07-31", coaId: "coa-1", config: {} } as unknown as BalanceContext;

function provider(key: string, compute: BalanceProvider["compute"]): BalanceProvider {
  return { key, label: key, kind: "derived", compute };
}

function method(over: Partial<BalanceMethod> = {}): BalanceMethod {
  return {
    key: "m1",
    label: "Method one",
    kind: "calculation",
    summary: "Does a thing.",
    steps: [{ providerKey: "p1", label: "Step one", description: "Adds up p1.", source: "somewhere", direction: "add" }],
    ...over,
  };
}

beforeEach(() => {
  __resetMethodRegistry();
  __resetRegistry();
});

describe("method registry", () => {
  it("registers and retrieves by key", () => {
    const m = method();
    registerMethod(m);
    expect(getMethod("m1")).toBe(m);
    expect(listMethods()).toEqual([m]);
  });

  it("returns undefined for an unknown key", () => {
    expect(getMethod("nope")).toBeUndefined();
  });

  it("throws on duplicate registration", () => {
    registerMethod(method());
    expect(() => registerMethod(method())).toThrow(/already registered: m1/);
  });

  it("rejects a method with no steps", () => {
    expect(() => registerMethod(method({ steps: [] }))).toThrow(/declares no steps/);
  });

  it("rejects duplicate step keys within one method", () => {
    const dup = method({
      steps: [
        { providerKey: "p1", label: "a", description: "a", source: "s", direction: "add" },
        { providerKey: "p1", label: "b", description: "b", source: "s", direction: "subtract" },
      ],
    });
    expect(() => registerMethod(dup)).toThrow(/duplicate step "p1"/);
  });

  it("allows the same provider twice when the steps are explicitly keyed apart", () => {
    const ok = method({
      steps: [
        { key: "p1-in", providerKey: "p1", label: "a", description: "a", source: "s", direction: "add" },
        { key: "p1-out", providerKey: "p1", label: "b", description: "b", source: "s", direction: "subtract" },
      ],
    });
    expect(() => registerMethod(ok)).not.toThrow();
  });

  it("defaults a step key to its provider key", () => {
    expect(stepKey({ providerKey: "p9", label: "l", description: "d", source: "s", direction: "net" })).toBe("p9");
    expect(stepKey({ key: "custom", providerKey: "p9", label: "l", description: "d", source: "s", direction: "net" })).toBe("custom");
  });

  it("methodsFor honors appliesTo and includes unfiltered methods", () => {
    const equityOnly = method({ key: "eq", appliesTo: (c) => c.statementSection === "equity" });
    const anywhere = method({ key: "any" });
    registerMethod(equityOnly);
    registerMethod(anywhere);

    const equityAccount = { statementSection: "equity" } as CoaAccountRef;
    const bankAccount = { statementSection: "bank" } as CoaAccountRef;

    expect(methodsFor(equityAccount).map((m) => m.key).sort()).toEqual(["any", "eq"]);
    expect(methodsFor(bankAccount).map((m) => m.key)).toEqual(["any"]);
  });
});

describe("runMethod", () => {
  it("sums non-null steps and records each under its step key", async () => {
    registerProvider(provider("p1", async () => 100));
    registerProvider(provider("p2", async () => -30));
    const m = method({
      steps: [
        { providerKey: "p1", label: "a", description: "a", source: "s", direction: "add" },
        { providerKey: "p2", label: "b", description: "b", source: "s", direction: "subtract" },
      ],
    });

    expect(await runMethod(m, ctx)).toEqual({ status: "ok", cents: 70, breakdown: { p1: 100, p2: -30 } });
  });

  it("a null step contributes nothing but does not block the others", async () => {
    registerProvider(provider("p1", async () => 100));
    registerProvider(provider("p2", async () => null));
    const m = method({
      steps: [
        { providerKey: "p1", label: "a", description: "a", source: "s", direction: "add" },
        { providerKey: "p2", label: "b", description: "b", source: "s", direction: "subtract" },
      ],
    });

    // Matches the June 2250 row in the golden fixture: accrual present,
    // postings absent, one contribution recorded rather than a zero.
    expect(await runMethod(m, ctx)).toEqual({ status: "ok", cents: 100, breakdown: { p1: 100 } });
  });

  it("returns empty when every step is null, so no row is written", async () => {
    registerProvider(provider("p1", async () => null));
    expect(await runMethod(method(), ctx)).toEqual({ status: "empty" });
  });

  it("treats a step returning 0 as a real contribution, not as absent", async () => {
    registerProvider(provider("p1", async () => 0));
    expect(await runMethod(method(), ctx)).toEqual({ status: "ok", cents: 0, breakdown: { p1: 0 } });
  });

  it("fails the WHOLE method when any step throws", async () => {
    registerProvider(provider("p1", async () => 395_483));
    registerProvider(provider("p2", async () => { throw new Error("Square unreachable"); }));
    const m = method({
      key: "salesTaxPayable",
      steps: [
        { providerKey: "p1", label: "a", description: "a", source: "s", direction: "add" },
        { providerKey: "p2", label: "b", description: "b", source: "s", direction: "subtract" },
      ],
    });

    const outcome = await runMethod(m, ctx);
    // The surviving step's 395,483 must NOT be reported as the balance. This is
    // the GL 2220 hazard: half an answer is indistinguishable from a whole one.
    expect(outcome.status).toBe("failed");
    expect(outcome).not.toHaveProperty("cents");
    if (outcome.status === "failed") {
      expect(outcome.errors[0]).toMatch(/Square unreachable/);
    }
  });

  it("fails the method when a step names an unregistered provider", async () => {
    const outcome = await runMethod(method(), ctx);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.errors[0]).toMatch(/unregistered provider "p1"/);
    }
  });

  it("reports every failing step, not just the first", async () => {
    registerProvider(provider("p1", async () => { throw new Error("one"); }));
    registerProvider(provider("p2", async () => { throw new Error("two"); }));
    const m = method({
      steps: [
        { providerKey: "p1", label: "a", description: "a", source: "s", direction: "add" },
        { providerKey: "p2", label: "b", description: "b", source: "s", direction: "add" },
      ],
    });
    const outcome = await runMethod(m, ctx);
    if (outcome.status !== "failed") throw new Error("expected failure");
    expect(outcome.errors).toHaveLength(2);
  });

  it("passes the context through to each provider unchanged", async () => {
    const spy = vi.fn(async () => 1);
    registerProvider(provider("p1", spy));
    await runMethod(method(), ctx);
    expect(spy).toHaveBeenCalledWith(ctx);
  });
});
