// Closing a period is the one write in this subsystem that makes a claim about
// the whole month, so these tests are mostly about what it REFUSES.
//
// Pure tests cover describeCloseBlockers -- the sentences a bookkeeper reads --
// and IO tests run closePeriod/reopenPeriod against a stateful fake Supabase in
// the same idiom as closeTasks.test.ts, with a real mutable store so "the
// period is now frozen and the close is recorded" is observable rather than
// mocked.
//
// The fake declares NO balance sources, so snapshotPeriod resolves nothing and
// reports no errors. That is deliberate: it isolates the close DECISION from
// the provider stack, which snapshot.test.ts and each provider's own tests
// already cover.
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  describeCloseBlockers,
  readPeriodClose,
  closePeriod,
  reopenPeriod,
  readPeriodCoverage,
  closedPeriodRefusal,
} from "./periodClose";
import { snapshotPeriod } from "./snapshot";

type Row = Record<string, unknown>;

interface FakeDb {
  closes: Row[];
  balances: Row[];
  tasks: Row[];
  sources: Row[];
  manualEntries: Row[];
  settings: Row[];
  accounts: Row[];
  profiles: Row[];
}

function emptyDb(over: Partial<FakeDb> = {}): FakeDb {
  return {
    closes: [],
    balances: [],
    tasks: [],
    sources: [],
    manualEntries: [],
    settings: [{ key: "balance_sheet_close", value: { due_day: 5, alert_lead_days: 0 } }],
    accounts: [],
    profiles: [],
    ...over,
  };
}

/**
 * Query-chain stub over a live array. `order`/`limit` are honoured because
 * readPeriodClose depends on both: current state is the NEWEST row for a
 * period, and reading the oldest instead would report a month as closed after
 * it had been reopened.
 */
function chain(rowsGetter: () => Row[]) {
  const filters: ((r: Row) => boolean)[] = [];
  let sort: { column: string; ascending: boolean } | null = null;
  let cap: number | null = null;

  const resolve = () => {
    let rows = rowsGetter().filter((r) => filters.every((f) => f(r)));
    if (sort) {
      const { column, ascending } = sort;
      rows = [...rows].sort((a, b) =>
        String(a[column]) < String(b[column]) ? (ascending ? -1 : 1) : String(a[column]) > String(b[column]) ? (ascending ? 1 : -1) : 0,
      );
    }
    return cap === null ? rows : rows.slice(0, cap);
  };

  const api: Record<string, unknown> = {
    eq(col: string, val: unknown) {
      filters.push((r) => r[col] === val);
      return api;
    },
    in(col: string, vals: unknown[]) {
      filters.push((r) => vals.includes(r[col]));
      return api;
    },
    select: () => api,
    order(column: string, opts?: { ascending?: boolean }) {
      sort = { column, ascending: opts?.ascending ?? true };
      return api;
    },
    limit(n: number) {
      cap = n;
      return api;
    },
    maybeSingle: async () => ({ data: resolve()[0] ?? null, error: null }),
    single: async () => ({ data: resolve()[0] ?? null, error: null }),
    then(onResolved: (v: { data: Row[]; error: null }) => unknown) {
      return Promise.resolve({ data: resolve(), error: null }).then(onResolved);
    },
  };
  return api;
}

/** update(...).eq(...) applied against the live array, awaited directly. */
function updatable(rowsGetter: () => Row[]) {
  return {
    ...chain(rowsGetter),
    update(patch: Row) {
      const filters: ((r: Row) => boolean)[] = [];
      const api: Record<string, unknown> = {
        eq(col: string, val: unknown) {
          filters.push((r) => r[col] === val);
          return api;
        },
        in: async (col: string, vals: unknown[]) => {
          for (const r of rowsGetter().filter((r) => filters.every((f) => f(r)) && vals.includes(r[col]))) {
            Object.assign(r, patch);
          }
          return { error: null };
        },
        select: async () => {
          const matched = rowsGetter().filter((r) => filters.every((f) => f(r)));
          for (const r of matched) Object.assign(r, patch);
          return { data: matched.map((r) => ({ id: r.id })), error: null };
        },
        then(onResolved: (v: { error: null }) => unknown) {
          for (const r of rowsGetter().filter((r) => filters.every((f) => f(r)))) Object.assign(r, patch);
          return Promise.resolve({ error: null }).then(onResolved);
        },
      };
      return api;
    },
  };
}

function makeFakeSupabase(db: FakeDb): SupabaseClient {
  let nextId = 1;
  return {
    from(table: string) {
      switch (table) {
        case "balance_period_closes":
          return {
            ...chain(() => db.closes),
            insert(row: Row) {
              const stored = { id: `close-${nextId++}`, created_at: `2026-08-02T1${db.closes.length}:00:00.000Z`, ...row };
              db.closes.push(stored);
              return {
                select: () => ({ single: async () => ({ data: stored, error: null }) }),
              };
            },
          };
        case "gl_account_balances":
          return {
            ...updatable(() => db.balances),
            upsert: async () => ({ error: null }),
          };
        case "balance_close_tasks":
          return {
            ...updatable(() => db.tasks),
            upsert: () => ({ select: async () => ({ data: [], error: null }) }),
          };
        case "balance_sheet_account_sources":
          return chain(() => db.sources);
        case "manual_entries":
          return chain(() => db.manualEntries);
        case "system_settings":
          return chain(() => db.settings);
        case "chart_of_accounts":
          return chain(() => db.accounts);
        case "profiles":
          return chain(() => db.profiles);
        default:
          throw new Error(`unexpected table: ${table}`);
      }
    },
  } as unknown as SupabaseClient;
}

// ── The sentences ────────────────────────────────────────────────────────────

describe("describeCloseBlockers", () => {
  const base = { periodEnd: "2026-06-30", todayIso: "2026-08-02", alreadyClosed: false, outstandingAccounts: [], snapshotErrors: [] };

  it("has nothing to say about a finished month, which is what makes it closable", () => {
    expect(describeCloseBlockers(base)).toEqual([]);
  });

  it("names the accounts that still owe an answer", () => {
    const [message] = describeCloseBlockers({
      ...base,
      outstandingAccounts: ["1010 · Cash on Hand", "1040 · Square Deposit"],
    });
    expect(message).toContain("2 accounts still have no answer for June 2026");
    expect(message).toContain("1010 · Cash on Hand");
    // The way out is part of the refusal: a skip with a reason is a real answer
    // to the close, and somebody stuck on a dead account has to be told so.
    expect(message).toContain("record why there is none");
  });

  it("refuses on a recalculation that errored, because the stored figures are not this month's", () => {
    const [message] = describeCloseBlockers({
      ...base,
      snapshotErrors: ['Provider "rampBalance" failed for account coa-1030: request timed out'],
    });
    expect(message).toContain("did not finish cleanly");
    expect(message).toContain("request timed out");
  });

  it("reports both problems at once rather than one at a time", () => {
    expect(
      describeCloseBlockers({ ...base, outstandingAccounts: ["1010 · Cash on Hand"], snapshotErrors: ["boom"] }),
    ).toHaveLength(2);
  });

  it("says nothing else about an already-closed month", () => {
    // Everything else would be stale: the checklist stopped being maintained at
    // the close, so listing it would be reporting on a period nobody is working.
    expect(describeCloseBlockers({ ...base, alreadyClosed: true, outstandingAccounts: ["1010 · Cash"] })).toEqual([
      "June 2026 is already closed.",
    ]);
  });

  it("refuses a month that has not ended yet", () => {
    const blockers = describeCloseBlockers({ ...base, periodEnd: "2026-08-31", todayIso: "2026-08-02" });
    expect(blockers).toEqual(["August 2026 has not ended yet, so there is nothing final to record."]);
  });
});

// ── State ────────────────────────────────────────────────────────────────────

describe("readPeriodClose", () => {
  it("reads the NEWEST event, so a reopened month is not still reported as closed", async () => {
    const db = emptyDb({
      closes: [
        { period_end: "2026-06-30", action: "closed", actor_id: "u1", reason: null, created_at: "2026-07-05T09:00:00.000Z" },
        { period_end: "2026-06-30", action: "reopened", actor_id: "u2", reason: "a June bill arrived in August", created_at: "2026-08-01T09:00:00.000Z" },
      ],
      profiles: [{ id: "u2", email: "bookkeeper@example.com" }],
    });

    const state = await readPeriodClose(makeFakeSupabase(db), "2026-06-30");

    expect(state?.closed).toBe(false);
    expect(state?.action).toBe("reopened");
    expect(state?.actorEmail).toBe("bookkeeper@example.com");
    expect(state?.reason).toBe("a June bill arrived in August");
  });

  it("is null for a month nobody has ever closed — not the same fact as reopened", async () => {
    expect(await readPeriodClose(makeFakeSupabase(emptyDb()), "2026-06-30")).toBeNull();
  });

  /**
   * Migrations here are authored and applied separately, so this code runs
   * against a database with no balance_period_closes table for a while. A
   * missing table has to answer "nobody has closed anything", which is true and
   * is also the pre-existing behaviour — everything recomputes, nothing
   * freezes. Throwing instead would take the close screen, the nudge banner and
   * every manual-entry write down with it.
   */
  it("answers 'never closed' rather than throwing when the table is not there yet", async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: async () => ({ data: null, error: { code: "42P01", message: 'relation "balance_period_closes" does not exist' } }),
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    expect(await readPeriodClose(supabase, "2026-06-30")).toBeNull();
  });
});

describe("a closed month stops recomputing", () => {
  /**
   * `is_frozen` is per ROW, so an account that gains a source AFTER the close
   * has no row to be frozen and would be written fresh into a month somebody
   * had already signed off. snapshotPeriod therefore refuses the whole period
   * up front, which this proves by making any read of the sources table an
   * error: reaching it at all means the refusal did not happen.
   */
  it("refuses the period before reading a single source", async () => {
    const db = emptyDb({
      closes: [
        { period_end: "2026-06-30", action: "closed", actor_id: "u1", reason: null, created_at: "2026-07-06T09:00:00.000Z" },
      ],
    });
    const real = makeFakeSupabase(db);
    const supabase = {
      from(table: string) {
        if (table === "balance_sheet_account_sources") throw new Error("snapshot read a closed period's sources");
        return (real as unknown as { from: (t: string) => unknown }).from(table);
      },
    } as unknown as SupabaseClient;

    await expect(snapshotPeriod(supabase, "2026-06-30", { todayIso: "2026-08-02" })).resolves.toEqual({
      written: 0,
      skipped: 0,
      errors: [],
      excluded: [],
    });
  });

  it("recomputes again once the month has been reopened", async () => {
    const db = emptyDb({
      closes: [
        { period_end: "2026-06-30", action: "closed", actor_id: "u1", reason: null, created_at: "2026-07-06T09:00:00.000Z" },
        { period_end: "2026-06-30", action: "reopened", actor_id: "u2", reason: "late bill", created_at: "2026-08-01T09:00:00.000Z" },
      ],
    });

    // No sources declared, so this is the ordinary empty result rather than the
    // refusal above -- reaching it at all is the assertion.
    await expect(snapshotPeriod(makeFakeSupabase(db), "2026-06-30", { todayIso: "2026-08-02" })).resolves.toMatchObject({
      written: 0,
      errors: [],
    });
  });
});

// ── Closing ──────────────────────────────────────────────────────────────────

describe("closePeriod", () => {
  const closer = { actorId: "user-1", todayIso: "2026-08-02" };

  it("freezes the period and records who did it", async () => {
    const db = emptyDb({
      balances: [{ chart_of_accounts_id: "coa-1", period_end: "2026-06-30", is_frozen: false }],
      profiles: [{ id: "user-1", email: "will@example.com" }],
    });
    const supabase = makeFakeSupabase(db);

    const result = await closePeriod(supabase, { periodEnd: "2026-06-30", ...closer });

    expect(result.ok).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(db.balances[0].is_frozen).toBe(true);
    expect(db.closes).toHaveLength(1);
    expect(db.closes[0]).toMatchObject({ period_end: "2026-06-30", action: "closed", actor_id: "user-1" });
    expect(result.state?.actorEmail).toBe("will@example.com");
  });

  it("refuses while an account still owes a balance, and writes nothing", async () => {
    const db = emptyDb({
      balances: [{ chart_of_accounts_id: "coa-1", period_end: "2026-06-30", is_frozen: false }],
      tasks: [
        {
          id: "t1",
          chart_of_accounts_id: "coa-1010",
          period_end: "2026-06-30",
          due_date: "2026-07-05",
          status: "open",
          alert_sent_at: null,
          completed_at: null,
          notes: null,
        },
      ],
      accounts: [{ id: "coa-1010", account_name: "Cash on Hand", account_number: "1010" }],
    });
    const supabase = makeFakeSupabase(db);

    const result = await closePeriod(supabase, { periodEnd: "2026-06-30", ...closer });

    expect(result.ok).toBe(false);
    expect(result.blockers[0]).toContain("1010 · Cash on Hand");
    // The whole point of refusing: nothing is final and nothing is frozen.
    expect(db.balances[0].is_frozen).toBe(false);
    expect(db.closes).toEqual([]);
  });

  it("refuses a month that has not ended, without recalculating it", async () => {
    const db = emptyDb();
    const result = await closePeriod(makeFakeSupabase(db), { periodEnd: "2026-08-31", ...closer });

    expect(result.ok).toBe(false);
    expect(result.snapshot).toBeNull();
    expect(db.closes).toEqual([]);
  });

  it("refuses a month that is already closed rather than recording a second close", async () => {
    const db = emptyDb({
      closes: [
        { period_end: "2026-06-30", action: "closed", actor_id: "u1", reason: null, created_at: "2026-07-06T09:00:00.000Z" },
      ],
    });

    const result = await closePeriod(makeFakeSupabase(db), { periodEnd: "2026-06-30", ...closer });

    expect(result.ok).toBe(false);
    expect(result.blockers).toEqual(["June 2026 is already closed."]);
    expect(db.closes).toHaveLength(1);
  });
});

// ── Reopening ────────────────────────────────────────────────────────────────

describe("reopenPeriod", () => {
  const closedDb = () =>
    emptyDb({
      closes: [
        { period_end: "2026-06-30", action: "closed", actor_id: "u1", reason: null, created_at: "2026-07-06T09:00:00.000Z" },
      ],
      balances: [{ chart_of_accounts_id: "coa-1", period_end: "2026-06-30", is_frozen: true }],
    });

  it("unfreezes the period and records who took it back, and why", async () => {
    const db = closedDb();

    const state = await reopenPeriod(makeFakeSupabase(db), {
      periodEnd: "2026-06-30",
      actorId: "user-2",
      reason: "a June supplier bill arrived in August",
    });

    expect(state?.closed).toBe(false);
    expect(db.balances[0].is_frozen).toBe(false);
    expect(db.closes[1]).toMatchObject({ action: "reopened", actor_id: "user-2" });
  });

  it("refuses a blank reason — reversing an assertion without saying why is not a reopen", async () => {
    const db = closedDb();
    await expect(reopenPeriod(makeFakeSupabase(db), { periodEnd: "2026-06-30", actorId: "u", reason: "   " })).rejects.toThrow(
      /why/i,
    );
    expect(db.balances[0].is_frozen).toBe(true);
  });

  it("returns null for a month that was never closed, so the caller can say so", async () => {
    const db = emptyDb();
    expect(await reopenPeriod(makeFakeSupabase(db), { periodEnd: "2026-06-30", actorId: "u", reason: "why not" })).toBeNull();
  });
});

// ── Writing into a closed month ──────────────────────────────────────────────

describe("closedPeriodRefusal", () => {
  it("refuses in words, naming the way out", async () => {
    const db = emptyDb({
      closes: [
        { period_end: "2026-06-30", action: "closed", actor_id: "u1", reason: null, created_at: "2026-07-06T09:00:00.000Z" },
      ],
    });

    const refusal = await closedPeriodRefusal(makeFakeSupabase(db), "2026-06-30");

    expect(refusal).toContain("June 2026 is closed");
    expect(refusal).toContain("Reopen the month");
  });

  it("allows a write into an open month", async () => {
    expect(await closedPeriodRefusal(makeFakeSupabase(emptyDb()), "2026-06-30")).toBeNull();
  });

  it("allows a write into a month that has been reopened", async () => {
    const db = emptyDb({
      closes: [
        { period_end: "2026-06-30", action: "closed", actor_id: "u1", reason: null, created_at: "2026-07-06T09:00:00.000Z" },
        { period_end: "2026-06-30", action: "reopened", actor_id: "u2", reason: "correction", created_at: "2026-08-01T09:00:00.000Z" },
      ],
    });
    expect(await closedPeriodRefusal(makeFakeSupabase(db), "2026-06-30")).toBeNull();
  });
});

// ── What closing asserts ─────────────────────────────────────────────────────

describe("readPeriodCoverage", () => {
  it("names the configured accounts that produced nothing this month", async () => {
    const db = emptyDb({
      sources: [
        { chart_of_accounts_id: "coa-a", active: true },
        { chart_of_accounts_id: "coa-b", active: true },
        // Two sources on one account is a shape the table allows (GL 2220), and
        // must count once.
        { chart_of_accounts_id: "coa-b", active: true },
      ],
      balances: [{ chart_of_accounts_id: "coa-a", period_end: "2026-06-30" }],
      accounts: [{ id: "coa-b", account_name: "Ramp Operating", account_number: "1030" }],
    });

    const coverage = await readPeriodCoverage(makeFakeSupabase(db), "2026-06-30");

    expect(coverage).toEqual({ configured: 2, withBalance: 1, missing: ["1030 · Ramp Operating"] });
  });
});
