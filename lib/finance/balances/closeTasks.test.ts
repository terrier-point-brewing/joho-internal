// Pure-logic tests (tasksNeedingAlert, isPeriodClosed) plus IO tests
// (ensureTasksForPeriod, reconcileCloseTasks) against a small stateful fake
// Supabase double -- same "generic table->rows fake stands in for Supabase"
// idiom as lib/finance/balances/providers/transactionPostings.test.ts, but
// with a real mutable store so ensureTasksForPeriod's upsert-ignoreDuplicates
// idempotency can be observed across two calls.
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ensureTasksForPeriod,
  tasksNeedingAlert,
  isPeriodClosed,
  reconcileCloseTasks,
} from "./closeTasks";
import type { CloseTask } from "./closeTasks";

type Row = Record<string, unknown>;

/** Thenable query-chain stub: eq/in accumulate predicates; awaiting (or .select()) applies them against `rowsGetter()`'s CURRENT contents, so mutations from a prior upsert/update are visible to later queries. */
function chain(rowsGetter: () => Row[]) {
  const filters: ((r: Row) => boolean)[] = [];
  const api: Record<string, unknown> = {
    eq(col: string, val: unknown) {
      filters.push((r) => r[col] === val);
      return api;
    },
    in(col: string, vals: unknown[]) {
      filters.push((r) => vals.includes(r[col]));
      return api;
    },
    select() {
      return api;
    },
    order() {
      return api;
    },
    maybeSingle: async () => {
      const rows = rowsGetter().filter((r) => filters.every((f) => f(r)));
      return { data: rows[0] ?? null, error: null };
    },
    then(resolve: (v: { data: Row[]; error: null }) => unknown) {
      const rows = rowsGetter().filter((r) => filters.every((f) => f(r)));
      return Promise.resolve({ data: rows, error: null }).then(resolve);
    },
  };
  return api;
}

interface FakeDb {
  sources: Row[];
  manualEntries: Row[];
  settings: Row[];
  closeTasks: Row[];
}

function makeFakeSupabase(db: FakeDb): SupabaseClient {
  let nextId = 1;

  return {
    from(table: string) {
      if (table === "balance_sheet_account_sources") return chain(() => db.sources);
      if (table === "manual_entries") return chain(() => db.manualEntries);
      if (table === "system_settings") return chain(() => db.settings);
      if (table === "balance_close_tasks") {
        return {
          ...chain(() => db.closeTasks),
          upsert: (rows: Row[]) => ({
            select: async () => {
              const inserted: Row[] = [];
              for (const row of rows) {
                const exists = db.closeTasks.some(
                  (t) =>
                    t.chart_of_accounts_id === row.chart_of_accounts_id &&
                    t.period_end === row.period_end,
                );
                if (!exists) {
                  const id = `task-${nextId++}`;
                  db.closeTasks.push({
                    id,
                    status: "open",
                    alert_sent_at: null,
                    completed_at: null,
                    ...row,
                  });
                  inserted.push({ id });
                }
              }
              return { data: inserted, error: null };
            },
          }),
          update: (patch: Row) => ({
            in: async (col: string, ids: unknown[]) => {
              for (const t of db.closeTasks) {
                if (ids.includes(t[col])) Object.assign(t, patch);
              }
              return { error: null };
            },
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;
}

function task(overrides: Partial<CloseTask> = {}): CloseTask {
  return {
    id: "t1",
    coaId: "coa-1",
    periodEnd: "2026-06-30",
    dueDate: "2026-07-05",
    status: "open",
    alertSentAt: null,
    ...overrides,
  };
}

describe("ensureTasksForPeriod", () => {
  it("is idempotent across two runs -- the second run creates no new tasks", async () => {
    const db: FakeDb = {
      sources: [
        { chart_of_accounts_id: "coa-1", provider_key: "manualBalance", active: true },
        { chart_of_accounts_id: "coa-2", provider_key: "manualBalance", active: true },
      ],
      manualEntries: [],
      settings: [{ key: "balance_sheet_close", value: { due_day: 5, alert_lead_days: 0 } }],
      closeTasks: [],
    };
    const supabase = makeFakeSupabase(db);

    const firstRun = await ensureTasksForPeriod(supabase, "2026-06-30");
    expect(firstRun).toBe(2);
    expect(db.closeTasks).toHaveLength(2);
    expect(db.closeTasks.every((t) => t.due_date === "2026-07-05")).toBe(true);

    const secondRun = await ensureTasksForPeriod(supabase, "2026-06-30");
    expect(secondRun).toBe(0);
    expect(db.closeTasks).toHaveLength(2);
  });

  it("skips an account that already has a manual_entries balance row for the period", async () => {
    const db: FakeDb = {
      sources: [
        { chart_of_accounts_id: "coa-1", provider_key: "manualBalance", active: true },
        { chart_of_accounts_id: "coa-2", provider_key: "manualBalance", active: true },
      ],
      manualEntries: [{ chart_of_accounts_id: "coa-1", entry_kind: "balance", as_of_date: "2026-06-30" }],
      settings: [{ key: "balance_sheet_close", value: { due_day: 5, alert_lead_days: 0 } }],
      closeTasks: [],
    };
    const supabase = makeFakeSupabase(db);

    const created = await ensureTasksForPeriod(supabase, "2026-06-30");

    expect(created).toBe(1);
    expect(db.closeTasks.map((t) => t.chart_of_accounts_id)).toEqual(["coa-2"]);
  });
});

describe("tasksNeedingAlert", () => {
  it("excludes the day before the alert threshold (dueDate - leadDays)", () => {
    const t = task({ dueDate: "2026-07-05" });
    expect(tasksNeedingAlert([t], "2026-07-01", 3)).toEqual([]);
  });

  it("includes the day of the alert threshold", () => {
    const t = task({ dueDate: "2026-07-05" });
    expect(tasksNeedingAlert([t], "2026-07-02", 3)).toEqual([t]);
  });

  it("includes the day after the alert threshold", () => {
    const t = task({ dueDate: "2026-07-05" });
    expect(tasksNeedingAlert([t], "2026-07-03", 3)).toEqual([t]);
  });

  it("never returns an already-alerted task", () => {
    const t = task({ dueDate: "2026-07-05", alertSentAt: "2026-07-02T00:00:00.000Z" });
    expect(tasksNeedingAlert([t], "2026-07-03", 3)).toEqual([]);
  });

  it("never returns a completed task", () => {
    const t = task({ dueDate: "2026-07-05", status: "completed" });
    expect(tasksNeedingAlert([t], "2026-07-05", 3)).toEqual([]);
  });
});

describe("isPeriodClosed", () => {
  it("is true when every task is completed or skipped", () => {
    const tasks = [task({ status: "completed" }), task({ id: "t2", status: "skipped" })];
    expect(isPeriodClosed(tasks)).toBe(true);
  });

  it("is false when any task is open", () => {
    const tasks = [task({ status: "completed" }), task({ id: "t2", status: "open" })];
    expect(isPeriodClosed(tasks)).toBe(false);
  });

  it("is true for an empty list", () => {
    expect(isPeriodClosed([])).toBe(true);
  });
});

describe("reconcileCloseTasks", () => {
  it("closes only tasks whose account now has a manual_entries balance row for the period", async () => {
    const db: FakeDb = {
      sources: [],
      manualEntries: [{ chart_of_accounts_id: "coa-1", entry_kind: "balance", as_of_date: "2026-06-30" }],
      settings: [],
      closeTasks: [
        {
          id: "t1",
          chart_of_accounts_id: "coa-1",
          period_end: "2026-06-30",
          due_date: "2026-07-05",
          status: "open",
          alert_sent_at: null,
          completed_at: null,
        },
        {
          id: "t2",
          chart_of_accounts_id: "coa-2",
          period_end: "2026-06-30",
          due_date: "2026-07-05",
          status: "open",
          alert_sent_at: null,
          completed_at: null,
        },
      ],
    };
    const supabase = makeFakeSupabase(db);

    const closed = await reconcileCloseTasks(supabase, "2026-06-30");

    expect(closed).toBe(1);
    expect(db.closeTasks.find((t) => t.id === "t1")?.status).toBe("completed");
    expect(db.closeTasks.find((t) => t.id === "t2")?.status).toBe("open");
  });

  it("closes nothing when no open task's account has a manual_entries row yet", async () => {
    const db: FakeDb = {
      sources: [],
      manualEntries: [],
      settings: [],
      closeTasks: [
        {
          id: "t1",
          chart_of_accounts_id: "coa-1",
          period_end: "2026-06-30",
          due_date: "2026-07-05",
          status: "open",
          alert_sent_at: null,
          completed_at: null,
        },
      ],
    };
    const supabase = makeFakeSupabase(db);

    const closed = await reconcileCloseTasks(supabase, "2026-06-30");

    expect(closed).toBe(0);
    expect(db.closeTasks[0].status).toBe("open");
  });
});
