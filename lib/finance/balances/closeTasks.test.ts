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
  dueDateForPeriod,
  dueDateForAccount,
  requiresMonthEndBalance,
  resolveResponsibleEmails,
  skipTask,
  reopenTask,
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
  profiles?: Row[];
}

/** The system_settings row every test needs; due day 5 is the migration's seeded default. */
const CLOSE_SETTINGS: Row[] = [{ key: "balance_sheet_close", value: { due_day: 5, alert_lead_days: 0 } }];

/** A close task as the table stores it, snake_case. */
function taskRow(over: Row = {}): Row {
  return {
    id: "t1",
    chart_of_accounts_id: "coa-1",
    period_end: "2026-06-30",
    due_date: "2026-07-05",
    status: "open",
    alert_sent_at: null,
    completed_at: null,
    notes: null,
    ...over,
  };
}

function makeFakeSupabase(db: FakeDb): SupabaseClient {
  let nextId = 1;

  return {
    from(table: string) {
      if (table === "balance_sheet_account_sources") return chain(() => db.sources);
      if (table === "manual_entries") return chain(() => db.manualEntries);
      if (table === "system_settings") return chain(() => db.settings);
      if (table === "profiles") return chain(() => db.profiles ?? []);
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
          // Two shapes of update reach this table and both must work against the
          // SAME mutable store: reconcileCloseTasks awaits `.in(...)` directly,
          // while skipTask/reopenTask narrow with `.eq(...).eq(...)` and then
          // ask `.select("id")` which rows they actually changed -- the return
          // value that tells "guard refused" apart from "nothing matched".
          update: (patch: Row) => {
            const filters: ((r: Row) => boolean)[] = [];
            const apply = (extra?: (r: Row) => boolean) => {
              const matched = db.closeTasks.filter((r) => filters.every((f) => f(r)) && (!extra || extra(r)));
              for (const r of matched) Object.assign(r, patch);
              return matched;
            };
            const api: Record<string, unknown> = {
              eq(col: string, val: unknown) {
                filters.push((r) => r[col] === val);
                return api;
              },
              in: async (col: string, ids: unknown[]) => {
                apply((r) => ids.includes(r[col]));
                return { error: null };
              },
              select: async () => ({ data: apply().map((r) => ({ id: r.id })), error: null }),
            };
            return api;
          },
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
    notes: null,
    ...overrides,
  };
}

/**
 * The rule that decides whether an account is chased at all.
 *
 * This is the highest-consequence assertion in the file. `requiresMonthEndBalance`
 * used to be read off the presence of an `operatorBalance` setup field, and
 * manual entry stopped declaring one when its setup was redesigned -- the
 * balance moved out of Settings, where it never belonged, and became the
 * monthly job it always was. Had the derivation not moved with it, every
 * manual account would have silently stopped raising close tasks: no task, no
 * alert, no banner, no error. Nothing to notice.
 *
 * Both methods are asserted, in both directions, because "manual entry still
 * works" and "nothing else got swept in" are separate failures.
 */
describe("requiresMonthEndBalance", () => {
  it("is true for manual entry, whose figure someone types every month", () => {
    expect(requiresMonthEndBalance("manualBalance")).toBe(true);
  });

  it("is true for the Square balance, which derives its movement but must be re-anchored by hand", () => {
    expect(requiresMonthEndBalance("squareStoredBalance")).toBe(true);
  });

  it("is false for every method that computes without a person", () => {
    for (const key of [
      "transactionPostings",
      "salesTaxPayable",
      "undistributedTips",
      "accountsReceivable",
      "retainedEarnings",
      "rampBalance",
      "plaidBankBalance",
    ]) {
      expect(requiresMonthEndBalance(key), key).toBe(false);
    }
  });

  it("is false for an unregistered key rather than throwing", () => {
    // This runs first in the close cron. Refusing to create ANY task because
    // one source names something unknown is worse than the unknown source.
    expect(requiresMonthEndBalance("somethingRetired")).toBe(false);
  });
});

describe("ensureTasksForPeriod", () => {
  it("raises a task for BOTH methods that need a hand-entered figure", async () => {
    // The end-to-end version of the assertion above: it is not enough that the
    // predicate is right, the account has to actually get a row.
    const db: FakeDb = {
      sources: [
        { chart_of_accounts_id: "coa-manual", provider_key: "manualBalance", active: true, config: {} },
        { chart_of_accounts_id: "coa-square", provider_key: "squareStoredBalance", active: true, config: {} },
        { chart_of_accounts_id: "coa-postings", provider_key: "transactionPostings", active: true, config: {} },
        { chart_of_accounts_id: "coa-ramp", provider_key: "rampBalance", active: true, config: {} },
      ],
      manualEntries: [],
      settings: CLOSE_SETTINGS,
      closeTasks: [],
    };

    const created = await ensureTasksForPeriod(makeFakeSupabase(db), "2026-06-30");

    expect(created).toBe(2);
    expect(db.closeTasks.map((t) => t.chart_of_accounts_id).sort()).toEqual(["coa-manual", "coa-square"]);
  });

  it("gives an account with its own allowance its own due date", async () => {
    // due_date has always been per-row; nothing was ever writing a different
    // one. An account waiting on a posted statement can now say so without
    // moving the deadline for every other account in the period.
    const db: FakeDb = {
      sources: [
        { chart_of_accounts_id: "coa-1", provider_key: "manualBalance", active: true, config: {} },
        {
          chart_of_accounts_id: "coa-2",
          provider_key: "manualBalance",
          active: true,
          config: { dueDaysAfterMonthEnd: 20 },
        },
      ],
      manualEntries: [],
      settings: CLOSE_SETTINGS,
      closeTasks: [],
    };

    await ensureTasksForPeriod(makeFakeSupabase(db), "2026-06-30");

    const byCoa = new Map(db.closeTasks.map((t) => [t.chart_of_accounts_id, t.due_date]));
    expect(byCoa.get("coa-1")).toBe("2026-07-05");
    expect(byCoa.get("coa-2")).toBe("2026-07-20");
  });

  it("ignores an override that would land on or before the month end", async () => {
    // A stored 0 or a negative would produce a due date inside the month being
    // closed, which reads as permanently overdue and alerts on sight.
    const db: FakeDb = {
      sources: [
        { chart_of_accounts_id: "coa-1", provider_key: "manualBalance", active: true, config: { dueDaysAfterMonthEnd: 0 } },
      ],
      manualEntries: [],
      settings: CLOSE_SETTINGS,
      closeTasks: [],
    };

    await ensureTasksForPeriod(makeFakeSupabase(db), "2026-06-30");

    expect(db.closeTasks[0].due_date).toBe("2026-07-05");
  });


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

  it("is FALSE for an empty list — Array.every's vacuous truth was the day-one freeze bug", () => {
    // This assertion previously read `.toBe(true)`, encoding the defect: with
    // no manualBalance source seeded, ensureTasksForPeriod returns zero tasks,
    // so the first cron run froze the prior month before its due date and
    // nothing could unfreeze it. "No tasks generated" != "all work done".
    expect(isPeriodClosed([])).toBe(false);
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

describe("isPeriodClosed — the empty case is the whole bug", () => {
  // Array.every is vacuously true, and nothing seeds a manualBalance source on
  // a fresh install, so ensureTasksForPeriod legitimately returns zero tasks.
  // The first cron run therefore froze the previous month on day one, before
  // its due date, with no unfreeze path anywhere.
  it("returns FALSE for an empty task list, not vacuously true", () => {
    expect(isPeriodClosed([])).toBe(false);
  });
});

describe("resolveResponsibleEmails", () => {
  const db = (): FakeDb => ({
    sources: [
      {
        chart_of_accounts_id: "coa-1",
        provider_key: "manualBalance",
        active: true,
        config: { responsibleUserId: "user-1" },
      },
      { chart_of_accounts_id: "coa-2", provider_key: "manualBalance", active: true, config: {} },
      {
        chart_of_accounts_id: "coa-3",
        provider_key: "manualBalance",
        active: true,
        config: { responsibleUserId: "user-gone" },
      },
    ],
    manualEntries: [],
    settings: CLOSE_SETTINGS,
    closeTasks: [],
    profiles: [{ id: "user-1", email: "bookkeeper@example.com" }],
  });

  it("maps an account to the person named on it", async () => {
    const emails = await resolveResponsibleEmails(makeFakeSupabase(db()), ["coa-1", "coa-2", "coa-3"]);
    expect(emails.get("coa-1")).toBe("bookkeeper@example.com");
  });

  it("omits an account with nobody named, so the caller falls back to the admin address", async () => {
    const emails = await resolveResponsibleEmails(makeFakeSupabase(db()), ["coa-1", "coa-2", "coa-3"]);
    expect(emails.has("coa-2")).toBe(false);
  });

  it("omits an account whose named person no longer has a login", async () => {
    // The alternative is an email addressed to a deleted user, which sends
    // successfully and reaches nobody -- the one failure mode this workflow
    // exists to prevent, and the hardest to notice.
    const emails = await resolveResponsibleEmails(makeFakeSupabase(db()), ["coa-1", "coa-2", "coa-3"]);
    expect(emails.has("coa-3")).toBe(false);
  });
});

describe("skipTask and reopenTask", () => {
  const db = (status: string, notes: string | null = null): FakeDb => ({
    sources: [],
    manualEntries: [],
    settings: CLOSE_SETTINGS,
    closeTasks: [taskRow({ status, notes })],
  });

  it("records the reason alongside the skip", async () => {
    // The reason IS the feature. A skip without one is indistinguishable from
    // ignoring the account, and a period closing on a pile of those is exactly
    // the false claim this checklist exists to avoid.
    const store = db("open");
    const done = await skipTask(makeFakeSupabase(store), "t1", "  the till was emptied and the account closed  ");

    expect(done).toBe(true);
    expect(store.closeTasks[0].status).toBe("skipped");
    expect(store.closeTasks[0].notes).toBe("the till was emptied and the account closed");
  });

  it("refuses a blank reason", async () => {
    await expect(skipTask(makeFakeSupabase(db("open")), "t1", "   ")).rejects.toThrow(/reason/i);
  });

  it("will not skip a task that is already completed", async () => {
    // A completed task has a real balance behind it. Letting a skip overwrite
    // that would replace evidence with an excuse.
    const store = db("completed");
    expect(await skipTask(makeFakeSupabase(store), "t1", "no longer used")).toBe(false);
    expect(store.closeTasks[0].status).toBe("completed");
  });

  it("puts a skipped task back on the list and clears its reason", async () => {
    const store = db("skipped", "closed the account");
    expect(await reopenTask(makeFakeSupabase(store), "t1")).toBe(true);
    expect(store.closeTasks[0].status).toBe("open");
    // The note read "why this month has no balance", which stops being true the
    // moment the account is outstanding again. The change itself survives in
    // audit_log.
    expect(store.closeTasks[0].notes).toBeNull();
  });

  it("will not reopen a task that was never skipped", async () => {
    const store = db("open");
    expect(await reopenTask(makeFakeSupabase(store), "t1")).toBe(false);
  });
});

describe("dueDateForAccount", () => {
  it("falls back to the business-wide due day when an account sets no allowance", () => {
    expect(dueDateForAccount("2026-06-30", 5, null)).toBe("2026-07-05");
  });

  it("counts an account's own allowance forward from the month end", () => {
    expect(dueDateForAccount("2026-06-30", 5, 10)).toBe("2026-07-10");
  });

  it("gives the same allowance regardless of how long the following month is", () => {
    // The two answers are deliberately different SHAPES: the global setting is
    // a day of the month, an account's override is a length of time. Ten days
    // after February's end and ten days after April's end are both ten days.
    expect(dueDateForAccount("2026-02-28", 5, 10)).toBe("2026-03-10");
    expect(dueDateForAccount("2026-04-30", 5, 10)).toBe("2026-05-10");
  });

  it("rolls a December period into the next year", () => {
    expect(dueDateForAccount("2026-12-31", 5, 10)).toBe("2027-01-10");
  });
});

describe("dueDateForPeriod", () => {
  // The cron used to read tasks[0].dueDate, which does not exist in exactly the
  // zero-task situation that matters. Deriving from config always works.
  it("puts the due day in the month AFTER the period", () => {
    expect(dueDateForPeriod("2026-07-31", 5)).toBe("2026-08-05");
  });

  it("rolls a December period into the next year", () => {
    expect(dueDateForPeriod("2026-12-31", 5)).toBe("2027-01-05");
  });
});
