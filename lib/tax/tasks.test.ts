import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TaxPartyTemplate, TaxPeriod, TaxTask, TaxSchedule } from "./types";
import { registerParty } from "./registry";
import { periodContaining, lastDayOfFollowingMonth } from "./period";
import {
  dueDateFor,
  periodsNeedingTasks,
  isAlertEligible,
  ensureTasksForSchedule,
  tasksNeedingAlert,
  markAlerted,
  getTask,
  listTasks,
  saveWorksheet,
  completeTask,
} from "./tasks";

// All `ref`/`today` dates are anchored at UTC noon so the calendar day they
// represent cannot drift across a host timezone — same convention as
// lib/tax/period.test.ts / lib/utils/datetime.ts.
function refDate(iso: string): Date {
  return new Date(`${iso}T12:00:00Z`);
}

// Stub party whose computePeriod mirrors the NC DOR rule (due = last day of
// the month following period end) without depending on Task 11's real party
// module, so this stays a pure test of the orchestration layer.
const stubParty: TaxPartyTemplate = {
  key: "stub-party",
  label: "Stub Party",
  supportedFrequencies: ["monthly", "quarterly", "annual"],
  computePeriod: (freq, ref) => {
    const { start, end } = periodContaining(freq, ref);
    const due = lastDayOfFollowingMonth(end);
    return { start, end, due };
  },
  defaultDueRule: (freq) => (freq === "monthly" ? { monthOffset: 1, day: 20 } : { monthOffset: 1, day: "last" }),
  computeWorksheet: async () => ({ fields: {} }),
  fieldOwnership: {},
  mergeWorksheet: (current) => current,
  settingsSchema: [],
  scheduleConfigSchema: [],
  buildReferenceView: () => ({ tables: [] }),
  worksheetComponent: "Stub",
};

describe("dueDateFor", () => {
  it("delegates to the party's computePeriod for the period containing periodEnd", () => {
    expect(dueDateFor(stubParty, "monthly", "2026-06-30")).toBe("2026-07-31");
  });

  it("works across a year boundary", () => {
    expect(dueDateFor(stubParty, "monthly", "2026-12-31")).toBe("2027-01-31");
  });
});

describe("periodsNeedingTasks", () => {
  it("monthly, today=2026-07-05, lookback=45: includes June and May, excludes July", () => {
    const periods = periodsNeedingTasks("monthly", refDate("2026-07-05"), 45, stubParty);
    expect(periods).toEqual<TaxPeriod[]>([
      { start: "2026-05-01", end: "2026-05-31", due: "2026-06-30" },
      { start: "2026-06-01", end: "2026-06-30", due: "2026-07-31" },
    ]);
  });

  it("excludes the not-yet-ended current period even with a huge lookback", () => {
    const periods = periodsNeedingTasks("monthly", refDate("2026-07-05"), 400, stubParty);
    expect(periods.some((p) => p.end === "2026-07-31")).toBe(false);
  });

  it("returns [] when lookback is 0", () => {
    expect(periodsNeedingTasks("monthly", refDate("2026-07-05"), 0, stubParty)).toEqual([]);
  });

  it("returns distinct periods with no duplicates for a lookback spanning multiple months", () => {
    const periods = periodsNeedingTasks("monthly", refDate("2026-07-05"), 100, stubParty);
    const ends = periods.map((p) => p.end);
    expect(new Set(ends).size).toBe(ends.length);
  });

  it("quarterly: today=2026-07-05, lookback=100 includes Q1 and Q2 (both ended), excludes Q3 (in progress)", () => {
    // Q1 2026 ends 2026-03-31, which falls within the 100-day trailing window
    // (2026-03-27..2026-07-04). Q2 2026 ends 2026-06-30 (also ended, in
    // window). Q3 2026 ends 2026-09-30 -> not yet ended -> excluded.
    const periods = periodsNeedingTasks("quarterly", refDate("2026-07-05"), 100, stubParty);
    expect(periods).toEqual<TaxPeriod[]>([
      { start: "2026-01-01", end: "2026-03-31", due: "2026-04-30" },
      { start: "2026-04-01", end: "2026-06-30", due: "2026-07-31" },
    ]);
  });
});

describe("isAlertEligible", () => {
  it("is eligible exactly on the threshold day (today == due - lead_days)", () => {
    expect(isAlertEligible("2026-07-13", "2026-07-20", 7)).toBe(true);
  });

  it("is not eligible one day before the threshold", () => {
    expect(isAlertEligible("2026-07-12", "2026-07-20", 7)).toBe(false);
  });

  it("is eligible after the threshold (including past the due date)", () => {
    expect(isAlertEligible("2026-08-01", "2026-07-20", 7)).toBe(true);
  });

  it("handles zero lead days (eligible only on/after the due date)", () => {
    expect(isAlertEligible("2026-07-19", "2026-07-20", 0)).toBe(false);
    expect(isAlertEligible("2026-07-20", "2026-07-20", 0)).toBe(true);
  });
});

// ── DB-wrapper tests (stubbed client, no real DB) ────────────────────────────

type Recorded = { table: string; op: string; payload?: unknown; args?: unknown[] };

function makeSchedule(overrides: Partial<TaxSchedule> = {}): TaxSchedule {
  return {
    id: "SCHED_1",
    party_key: "stub-party",
    frequency: "monthly",
    lead_days: 7,
    active: true,
    config: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("ensureTasksForSchedule", () => {
  it("upserts one row per period-needing-task, onConflict (schedule_id,period_end), and counts only newly created rows", async () => {
    registerParty(stubParty);
    const recorded: Recorded[] = [];
    const insertedIds = ["T1", "T2"];
    const client = {
      from: (table: string) => ({
        upsert: (payload: unknown, opts: unknown) => {
          recorded.push({ table, op: "upsert", payload, args: [opts] });
          return {
            select: () => Promise.resolve({ data: insertedIds.map((id) => ({ id })), error: null }),
          };
        },
      }),
    } as unknown as SupabaseClient;

    const schedule = makeSchedule();
    const result = await ensureTasksForSchedule(client, schedule, refDate("2026-07-05"), 45);

    expect(result).toEqual({ created: 2 });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].table).toBe("tax_tasks");
    expect(recorded[0].args?.[0]).toMatchObject({ onConflict: "schedule_id,period_end" });
    // due_date is now resolved via resolveDueDate(period.end, rule) — rule
    // falls back to stubParty.defaultDueRule("monthly") since schedule.config
    // has no dueRule, which resolves to the 20th of the following month
    // (period.end/computePeriod's own `.due` is no longer read here).
    expect(recorded[0].payload).toEqual([
      {
        schedule_id: "SCHED_1",
        party_key: "stub-party",
        period_start: "2026-05-01",
        period_end: "2026-05-31",
        due_date: "2026-06-20",
      },
      {
        schedule_id: "SCHED_1",
        party_key: "stub-party",
        period_start: "2026-06-01",
        period_end: "2026-06-30",
        due_date: "2026-07-20",
      },
    ]);
  });

  it("uses the schedule's config.dueRule to compute due_date when present", async () => {
    registerParty(stubParty);
    const recorded: Recorded[] = [];
    const client = {
      from: (table: string) => ({
        upsert: (payload: unknown, opts: unknown) => {
          recorded.push({ table, op: "upsert", payload, args: [opts] });
          return { select: () => Promise.resolve({ data: [], error: null }) };
        },
      }),
    } as unknown as SupabaseClient;

    const schedule = makeSchedule({ config: { dueRule: { monthOffset: 1, day: 25 } } });
    await ensureTasksForSchedule(client, schedule, refDate("2026-07-05"), 45);

    const payload = recorded[0].payload as { due_date: string }[];
    expect(payload.every((row) => row.due_date.endsWith("-25"))).toBe(true);
  });

  it("falls back to the party's defaultDueRule when config has no dueRule", async () => {
    registerParty(stubParty);
    const recorded: Recorded[] = [];
    const client = {
      from: (table: string) => ({
        upsert: (payload: unknown, opts: unknown) => {
          recorded.push({ table, op: "upsert", payload, args: [opts] });
          return { select: () => Promise.resolve({ data: [], error: null }) };
        },
      }),
    } as unknown as SupabaseClient;

    const schedule = makeSchedule({ config: {} });
    await ensureTasksForSchedule(client, schedule, refDate("2026-07-05"), 45);

    const payload = recorded[0].payload as { due_date: string }[];
    expect(payload.every((row) => row.due_date.endsWith("-20"))).toBe(true);
  });

  it("skips the DB round-trip entirely when there are no periods needing tasks (lookback=0)", async () => {
    registerParty(stubParty);
    const recorded: Recorded[] = [];
    const client = {
      from: (table: string) => {
        recorded.push({ table, op: "from" });
        return { upsert: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) };
      },
    } as unknown as SupabaseClient;

    const result = await ensureTasksForSchedule(client, makeSchedule(), refDate("2026-07-05"), 0);

    expect(result).toEqual({ created: 0 });
    expect(recorded).toEqual([]);
  });

  it("throws with the Supabase error message on upsert failure", async () => {
    registerParty(stubParty);
    const client = {
      from: () => ({
        upsert: () => ({
          select: () => Promise.resolve({ data: null, error: { message: "boom" } }),
        }),
      }),
    } as unknown as SupabaseClient;

    await expect(
      ensureTasksForSchedule(client, makeSchedule(), refDate("2026-07-05"), 45),
    ).rejects.toThrow(/boom/);
  });
});

describe("tasksNeedingAlert", () => {
  it("returns only open, unsent tasks whose eligibility predicate passes, using each task's schedule lead_days", async () => {
    const rows = [
      { id: "T1", due_date: "2026-07-20", tax_schedules: { lead_days: 7 } }, // threshold 07-13, today 07-13 -> eligible
      { id: "T2", due_date: "2026-08-01", tax_schedules: { lead_days: 7 } }, // threshold 07-25 -> not eligible yet
    ];
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({
            is: () => Promise.resolve({ data: rows, error: null }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    const result = await tasksNeedingAlert(client, refDate("2026-07-13"));

    expect(result.map((t) => t.id)).toEqual(["T1"]);
  });

  it("throws with the Supabase error message on query failure", async () => {
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({
            is: () => Promise.resolve({ data: null, error: { message: "boom" } }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    await expect(tasksNeedingAlert(client, refDate("2026-07-13"))).rejects.toThrow(/boom/);
  });
});

describe("markAlerted", () => {
  it("updates alert_sent_at and updated_at for the given task id", async () => {
    const recorded: Recorded[] = [];
    const client = {
      from: (table: string) => ({
        update: (payload: unknown) => ({
          eq: (col: string, val: unknown) => {
            recorded.push({ table, op: "update", payload, args: [col, val] });
            return Promise.resolve({ error: null });
          },
        }),
      }),
    } as unknown as SupabaseClient;

    await markAlerted(client, "T1");

    expect(recorded).toHaveLength(1);
    expect(recorded[0].args).toEqual(["id", "T1"]);
    expect(recorded[0].payload).toMatchObject({ alert_sent_at: expect.any(String) });
  });
});

describe("getTask / listTasks / saveWorksheet / completeTask", () => {
  const sampleTask: TaxTask = {
    id: "T1",
    schedule_id: "SCHED_1",
    party_key: "stub-party",
    period_start: "2026-06-01",
    period_end: "2026-06-30",
    due_date: "2026-07-31",
    status: "open",
    alert_sent_at: null,
    worksheet: null,
    confirmation_number: null,
    amount_paid_cents: null,
    submitted_on: null,
    notes: null,
    completed_at: null,
    completed_by: null,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
  };

  it("getTask returns null when no row matches", async () => {
    const client = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
    } as unknown as SupabaseClient;

    expect(await getTask(client, "missing")).toBeNull();
  });

  it("getTask returns the task row", async () => {
    const client = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: sampleTask, error: null }) }) }) }),
    } as unknown as SupabaseClient;

    expect(await getTask(client, "T1")).toEqual(sampleTask);
  });

  it("listTasks applies status/partyKey/scheduleId filters when provided", async () => {
    const recorded: string[] = [];
    const client = {
      from: () => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.order = () => b;
        b.eq = (col: string) => {
          recorded.push(col);
          return b;
        };
        b.then = (resolve: (v: unknown) => void) => resolve({ data: [sampleTask], error: null });
        return b;
      },
    } as unknown as SupabaseClient;

    const result = await listTasks(client, { status: "open", partyKey: "stub-party", scheduleId: "SCHED_1" });

    expect(result).toEqual([sampleTask]);
    expect(recorded).toEqual(["status", "party_key", "schedule_id"]);
  });

  it("saveWorksheet updates the worksheet column and returns the updated row", async () => {
    const recorded: Recorded[] = [];
    const client = {
      from: (table: string) => ({
        update: (payload: unknown) => {
          recorded.push({ table, op: "update", payload });
          return { eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: { ...sampleTask, worksheet: { fields: { a: 1 } } }, error: null }) }) }) };
        },
      }),
    } as unknown as SupabaseClient;

    const result = await saveWorksheet(client, "T1", { fields: { a: 1 } });

    expect(result.worksheet).toEqual({ fields: { a: 1 } });
    expect(recorded[0].payload).toMatchObject({ worksheet: { fields: { a: 1 } } });
  });

  it("completeTask sets status=completed plus confirmation fields and completed_by", async () => {
    const recorded: Recorded[] = [];
    const client = {
      from: (table: string) => ({
        update: (payload: unknown) => {
          recorded.push({ table, op: "update", payload });
          return {
            eq: () => ({
              select: () => ({
                single: () =>
                  Promise.resolve({
                    data: { ...sampleTask, status: "completed", confirmation_number: "CONF-1" },
                    error: null,
                  }),
              }),
            }),
          };
        },
      }),
    } as unknown as SupabaseClient;

    const result = await completeTask(client, "T1", {
      confirmation_number: "CONF-1",
      amount_paid_cents: 12345,
      submitted_on: "2026-07-15",
      notes: "filed on time",
      userId: "USER_1",
    });

    expect(result.status).toBe("completed");
    expect(recorded[0].payload).toMatchObject({
      status: "completed",
      confirmation_number: "CONF-1",
      amount_paid_cents: 12345,
      submitted_on: "2026-07-15",
      notes: "filed on time",
      completed_by: "USER_1",
    });
  });
});
