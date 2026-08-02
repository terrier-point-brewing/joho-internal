/**
 * expandSources turns declared balance_sheet_account_sources rows into the
 * per-step values resolveSnapshotWrites consumes.
 *
 * The load-bearing property under test is that a source row naming a METHOD and
 * the pre-migration rows naming its individual PROVIDERS produce byte-identical
 * output. That is what makes the code deploy and the data migration safe in
 * either order, with no window where the balance sheet reads wrong.
 *
 * Providers are replaced with fakes here so the arithmetic is legible; the real
 * providers keep their own tests, which this refactor did not touch.
 */
import { describe, it, expect, beforeEach } from "vitest";
import "./methods";
import { expandSources, resolveSnapshotWrites, type DeclaredSource } from "./snapshot";
import { registerProvider, __resetRegistry, type BalanceProvider } from "./registry";
import { getMethod } from "./methods/registry";

type AdminClient = Parameters<typeof expandSources>[0];
const supabase = {} as AdminClient;
const PERIOD = "2026-07-31";
const COA = "coa-2220";

function fake(key: string, value: number | null | (() => never)): BalanceProvider {
  return {
    key,
    label: key,
    kind: "derived",
    async compute() {
      if (typeof value === "function") value();
      return value as number | null;
    },
  };
}

function declared(...keys: string[]): DeclaredSource[] {
  return keys.map((providerKey) => ({ coaId: COA, providerKey, config: {} }));
}

beforeEach(() => {
  // Clears PROVIDERS only. Methods stay registered from the barrel import above,
  // so the real salesTaxPayable definition is what gets exercised.
  __resetRegistry();
});

describe("expandSources", () => {
  it("expands a method into one entry per non-null step, keyed by step key", async () => {
    registerProvider(fake("taxAccrual", -297_509));
    registerProvider(fake("transactionPostings", 395_483));

    const out = await expandSources(supabase, PERIOD, declared("salesTaxPayable"));

    expect(out.errors).toEqual([]);
    expect(out.failedAccounts.size).toBe(0);
    expect(out.sources).toEqual([
      { coaId: COA, providerKey: "taxAccrual" },
      { coaId: COA, providerKey: "transactionPostings" },
    ]);
    expect(out.results.get(`${COA}:taxAccrual`)).toBe(-297_509);
    expect(out.results.get(`${COA}:transactionPostings`)).toBe(395_483);
  });

  it("still resolves a bare provider key written before the method migration", async () => {
    registerProvider(fake("taxAccrual", -186_559));

    const out = await expandSources(supabase, PERIOD, declared("taxAccrual"));

    expect(out.errors).toEqual([]);
    expect(out.results.get(`${COA}:taxAccrual`)).toBe(-186_559);
  });

  it("produces the SAME result pre-migration and post-migration", async () => {
    // The deploy-safety guarantee, asserted rather than asserted-about.
    // Pre-migration GL 2220 carries two rows; post-migration it carries one.
    // Both must land on 97,974 with the same two contributions.
    const values = () => {
      __resetRegistry();
      registerProvider(fake("taxAccrual", -297_509));
      registerProvider(fake("transactionPostings", 395_483));
    };

    values();
    const before = await expandSources(supabase, PERIOD, declared("taxAccrual", "transactionPostings"));
    values();
    const after = await expandSources(supabase, PERIOD, declared("salesTaxPayable"));

    const writesBefore = resolveSnapshotWrites(before.sources, before.results, new Map());
    const writesAfter = resolveSnapshotWrites(after.sources, after.results, new Map());

    expect(writesAfter).toEqual(writesBefore);
    expect(writesAfter).toEqual([
      {
        coaId: COA,
        balanceCents: 97_974,
        contributions: { taxAccrual: -297_509, transactionPostings: 395_483 },
      },
    ]);
  });

  it("omits a null step but keeps the rest, matching the June 2250 shape", async () => {
    registerProvider(fake("taxAccrual", -14_486));
    registerProvider(fake("transactionPostings", null));

    const out = await expandSources(supabase, PERIOD, declared("salesTaxPayable"));

    expect(out.sources).toEqual([{ coaId: COA, providerKey: "taxAccrual" }]);
    const writes = resolveSnapshotWrites(out.sources, out.results, new Map());
    expect(writes).toEqual([
      { coaId: COA, balanceCents: -14_486, contributions: { taxAccrual: -14_486 } },
    ]);
  });

  it("contributes nothing when every step of a method is null", async () => {
    registerProvider(fake("taxAccrual", null));
    registerProvider(fake("transactionPostings", null));

    const out = await expandSources(supabase, PERIOD, declared("salesTaxPayable"));

    expect(out.sources).toEqual([]);
    expect(out.failedAccounts.size).toBe(0);
    expect(resolveSnapshotWrites(out.sources, out.results, new Map())).toEqual([]);
  });

  it("fails the whole account when one step throws, contributing no partial sum", async () => {
    registerProvider(fake("taxAccrual", -297_509));
    registerProvider(fake("transactionPostings", () => { throw new Error("Square unreachable"); }));

    const out = await expandSources(supabase, PERIOD, declared("salesTaxPayable"));

    expect(out.failedAccounts.has(COA)).toBe(true);
    expect(out.sources).toEqual([]);
    expect(out.errors[0]).toMatch(/Square unreachable/);
    expect(out.errors[0]).toMatch(new RegExp(`account ${COA}`));
  });

  it("reports an unknown key as a failure rather than throwing", async () => {
    const out = await expandSources(supabase, PERIOD, declared("notARealThing"));

    expect(out.failedAccounts.has(COA)).toBe(true);
    expect(out.errors[0]).toMatch(/Unknown balance method or provider "notARealThing"/);
  });

  it("isolates a failing account from a healthy one", async () => {
    registerProvider(fake("transactionPostings", 40_600));
    const rows: DeclaredSource[] = [
      { coaId: "coa-2230", providerKey: "transactionPostings", config: {} },
      { coaId: "coa-bad", providerKey: "notARealThing", config: {} },
    ];

    const out = await expandSources(supabase, PERIOD, rows);

    expect(out.failedAccounts.has("coa-bad")).toBe(true);
    expect(out.failedAccounts.has("coa-2230")).toBe(false);
    const writes = resolveSnapshotWrites(out.sources, out.results, new Map())
      .filter((w) => !out.failedAccounts.has(w.coaId));
    expect(writes).toEqual([
      { coaId: "coa-2230", balanceCents: 40_600, contributions: { transactionPostings: 40_600 } },
    ]);
  });

  it("passes each source's own config through to its provider", async () => {
    let seen: unknown;
    registerProvider({
      key: "manualBalance",
      label: "m",
      kind: "manual",
      async compute(ctx) { seen = ctx.config; return 1; },
    });

    await expandSources(supabase, PERIOD, [
      { coaId: COA, providerKey: "manualBalance", config: { accountId: "abc" } },
    ]);

    expect(seen).toEqual({ accountId: "abc" });
  });

  /**
   * Backfilling an older month must not ask a provider a question only today
   * can answer. GL 1100 is the live case and the reason a decision was needed
   * before any backfill code was written: `openInvoiceAr` sums invoices open
   * NOW, so run against March it returns March's invoices still unpaid today —
   * an understatement of March's receivables with nothing in the number to say
   * so, and `invoices` has no payment date to reconstruct the real answer from.
   */
  describe("backfilling an older month", () => {
    function arSources(): DeclaredSource[] {
      return [{ coaId: "coa-1100", providerKey: "accountsReceivable", config: {} }];
    }

    it("leaves out the WHOLE account, not just the step that cannot answer", async () => {
      registerProvider({ ...fake("openInvoiceAr", 982_188), dependsOnCurrentState: true });
      registerProvider(fake("transactionPostings", 5_000));

      const out = await expandSources(supabase, PERIOD, arSources(), true);

      expect(out.excluded).toEqual(["coa-1100"]);
      // Dropping only the step would write the surviving 5,000 as if it were
      // the whole of A/R — the GL 2220 partial-sum failure, in a month nobody
      // is watching.
      expect(out.sources).toEqual([]);
      expect(out.failedAccounts.has("coa-1100")).toBe(true);
      // Not an error: declining to guess is a decision, and lumping it in with
      // failures trains a reader to ignore both.
      expect(out.errors).toEqual([]);
    });

    it("asks the same account normally when the month is not historical", async () => {
      registerProvider({ ...fake("openInvoiceAr", 982_188), dependsOnCurrentState: true });
      registerProvider(fake("transactionPostings", 5_000));

      const out = await expandSources(supabase, PERIOD, arSources(), false);

      expect(out.excluded).toEqual([]);
      expect(out.results.get("coa-1100:openInvoiceAr")).toBe(982_188);
    });

    it("backfills every account whose calculation is genuinely as-at-date", async () => {
      registerProvider(fake("taxAccrual", -297_509));
      registerProvider(fake("transactionPostings", 395_483));

      const out = await expandSources(supabase, PERIOD, declared("salesTaxPayable"), true);

      expect(out.excluded).toEqual([]);
      expect(out.results.get(`${COA}:taxAccrual`)).toBe(-297_509);
    });
  });

  it("every built-in method resolves against the real provider registry", async () => {
    // Guards the barrel: a method referencing a provider nobody registered
    // would otherwise surface only as a silently skipped account in a cron run.
    __resetRegistry();
    await import("./providers");
    for (const key of ["salesTaxPayable", "undistributedTips", "accountsReceivable", "retainedEarnings", "manualBalance", "transactionPostings"]) {
      const method = getMethod(key);
      expect(method, key).toBeDefined();
      const out = await expandSources(supabase, PERIOD, declared(key));
      expect(out.errors.filter((e) => /Unknown balance method or provider/.test(e)), key).toEqual([]);
    }
  });
});
