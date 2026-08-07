import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TaxSchedule } from "./types";
import { listSchedules, createSchedule, updateSchedule, setScheduleActive, getSchedule, listActivePartyKeys } from "./schedules";

const sampleSchedule: TaxSchedule = {
  id: "SCHED_1",
  filing_key: "nc_dor_su",
  frequency: "monthly",
  lead_days: 7,
  active: true,
  config: {},
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

type Recorded = { table: string; op: string; payload?: unknown; args?: unknown[] };

describe("listSchedules", () => {
  it("returns all schedules ordered by created_at when no filter is given", async () => {
    const recorded: Recorded[] = [];
    const client = {
      from: (table: string) => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.order = (col: string, opts: unknown) => {
          recorded.push({ table, op: "order", args: [col, opts] });
          return b;
        };
        b.then = (resolve: (v: unknown) => void) => resolve({ data: [sampleSchedule], error: null });
        return b;
      },
    } as unknown as SupabaseClient;

    const result = await listSchedules(client);

    expect(result).toEqual([sampleSchedule]);
    expect(recorded).toEqual([{ table: "tax_schedules", op: "order", args: ["created_at", { ascending: true }] }]);
  });

  it("applies partyKey and activeOnly filters when provided", async () => {
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
        b.then = (resolve: (v: unknown) => void) => resolve({ data: [sampleSchedule], error: null });
        return b;
      },
    } as unknown as SupabaseClient;

    await listSchedules(client, { partyKey: "nc_dor_su", activeOnly: true });

    expect(recorded).toEqual(["filing_key", "active"]);
  });

  it("throws with the Supabase error message on query failure", async () => {
    const client = {
      from: () => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.order = () => b;
        b.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: "boom" } });
        return b;
      },
    } as unknown as SupabaseClient;

    await expect(listSchedules(client)).rejects.toThrow(/boom/);
  });
});

describe("getSchedule", () => {
  it("returns the schedule when a row matches the id", async () => {
    const client = {
      from: () => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = () => b;
        b.maybeSingle = () => Promise.resolve({ data: sampleSchedule, error: null });
        return b;
      },
    } as unknown as SupabaseClient;

    const result = await getSchedule(client, "SCHED_1");
    expect(result).toEqual(sampleSchedule);
  });

  it("returns null when no schedule matches the id", async () => {
    const client = {
      from: () => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = () => b;
        b.maybeSingle = () => Promise.resolve({ data: null, error: null });
        return b;
      },
    } as unknown as SupabaseClient;

    const result = await getSchedule(client, "MISSING");
    expect(result).toBeNull();
  });

  it("throws with the Supabase error message on query failure", async () => {
    const client = {
      from: () => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = () => b;
        b.maybeSingle = () => Promise.resolve({ data: null, error: { message: "boom" } });
        return b;
      },
    } as unknown as SupabaseClient;

    await expect(getSchedule(client, "SCHED_1")).rejects.toThrow(/boom/);
  });
});

describe("createSchedule", () => {
  it("inserts with defaults for lead_days/active/config when omitted", async () => {
    const recorded: Recorded[] = [];
    const client = {
      from: (table: string) => ({
        insert: (payload: unknown) => {
          recorded.push({ table, op: "insert", payload });
          return { select: () => ({ single: () => Promise.resolve({ data: sampleSchedule, error: null }) }) };
        },
      }),
    } as unknown as SupabaseClient;

    const result = await createSchedule(client, { filing_key: "nc_dor_su", frequency: "monthly" });

    expect(result).toEqual(sampleSchedule);
    expect(recorded[0].payload).toMatchObject({
      filing_key: "nc_dor_su",
      frequency: "monthly",
      lead_days: 7,
      active: true,
      config: {},
    });
  });

  it("respects explicit lead_days/active/config overrides", async () => {
    const recorded: Recorded[] = [];
    const client = {
      from: (table: string) => ({
        insert: (payload: unknown) => {
          recorded.push({ table, op: "insert", payload });
          return { select: () => ({ single: () => Promise.resolve({ data: sampleSchedule, error: null }) }) };
        },
      }),
    } as unknown as SupabaseClient;

    await createSchedule(client, {
      filing_key: "nc_dor_su",
      frequency: "quarterly",
      lead_days: 14,
      active: false,
      config: { counties: ["Wake"] },
    });

    expect(recorded[0].payload).toMatchObject({
      lead_days: 14,
      active: false,
      config: { counties: ["Wake"] },
    });
  });
});

describe("updateSchedule", () => {
  it("updates the given patch fields", async () => {
    const recorded: Recorded[] = [];
    const client = {
      from: (table: string) => ({
        update: (payload: unknown) => {
          recorded.push({ table, op: "update", payload });
          return {
            eq: () => ({
              select: () => ({ single: () => Promise.resolve({ data: { ...sampleSchedule, lead_days: 10 }, error: null }) }),
            }),
          };
        },
      }),
    } as unknown as SupabaseClient;

    const result = await updateSchedule(client, "SCHED_1", { lead_days: 10 });

    expect(result.lead_days).toBe(10);
    expect(recorded[0].payload).toMatchObject({ lead_days: 10 });
  });
});

describe("setScheduleActive", () => {
  it("delegates to updateSchedule with just the active flag", async () => {
    const recorded: Recorded[] = [];
    const client = {
      from: (table: string) => ({
        update: (payload: unknown) => {
          recorded.push({ table, op: "update", payload });
          return {
            eq: () => ({
              select: () => ({ single: () => Promise.resolve({ data: { ...sampleSchedule, active: false }, error: null }) }),
            }),
          };
        },
      }),
    } as unknown as SupabaseClient;

    const result = await setScheduleActive(client, "SCHED_1", false);

    expect(result.active).toBe(false);
    expect(recorded[0].payload).toMatchObject({ active: false });
  });
});

describe("listActivePartyKeys", () => {
  it("returns distinct filing_key values from active schedules only", async () => {
    // listActivePartyKeys calls listSchedules(sb, { activeOnly: true }), which
    // issues .eq("active", true) — the stub simulates the DB already having
    // applied that filter, matching the existing stub convention in this file
    // (see "applies partyKey and activeOnly filters when provided" above).
    const activeRows: TaxSchedule[] = [
      { ...sampleSchedule, id: "s1", filing_key: "nc_dor_beer_excise", active: true },
      { ...sampleSchedule, id: "s2", filing_key: "nc_dor_beer_excise", active: true },
    ];
    const client = {
      from: () => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.order = () => b;
        b.eq = () => b;
        b.then = (resolve: (v: unknown) => void) => resolve({ data: activeRows, error: null });
        return b;
      },
    } as unknown as SupabaseClient;

    const result = await listActivePartyKeys(client);
    expect(result).toEqual(["nc_dor_beer_excise"]);
  });
});
