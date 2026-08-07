import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  reconcileRegistrations,
  listRegistrations,
  saveRegistrations,
  resolveRequiredRegistrations,
  BASE_REQUIRED_REGISTRATIONS,
  type TaxRegistration,
  type TaxRegistrationInput,
  type RequiredRegistration,
} from "./registrations";

const sampleRegistrations: TaxRegistration[] = [
  { id: "r1", authority_key: "irs", label: "Federal EIN (FEIN)", number: "12-3456789", display_order: 0, key: "fein" },
  { id: "r2", authority_key: "nc_dor", label: "Account / License #", number: "NC-999", display_order: 0, key: "nc_dor_account_id" },
];

describe("reconcileRegistrations", () => {
  it("does not delete anything for an incoming row without an id (insert case)", () => {
    const { deleteIds } = reconcileRegistrations(["r1"], [{ id: "r1" }, {}]);
    expect(deleteIds).toEqual([]);
  });

  it("deletes an existing id absent from incoming (delete case)", () => {
    const { deleteIds } = reconcileRegistrations(["r1", "r2"], [{ id: "r1" }]);
    expect(deleteIds).toEqual(["r2"]);
  });

  it("keeps an existing id present in incoming (update case)", () => {
    const { deleteIds } = reconcileRegistrations(["r1", "r2"], [{ id: "r1" }, { id: "r2" }]);
    expect(deleteIds).toEqual([]);
  });
});

describe("listRegistrations", () => {
  it("returns rows ordered by authority_key then display_order", async () => {
    const recorded: { col: string }[] = [];
    const client = {
      from: () => {
        const b: Record<string, unknown> = {};
        let orderCalls = 0;
        b.select = () => b;
        b.order = (col: string) => {
          recorded.push({ col });
          orderCalls += 1;
          if (orderCalls === 2) {
            return Promise.resolve({ data: sampleRegistrations, error: null });
          }
          return b;
        };
        return b;
      },
    } as unknown as SupabaseClient;

    const result = await listRegistrations(client);
    expect(result).toEqual(sampleRegistrations);
    expect(recorded).toEqual([{ col: "authority_key" }, { col: "display_order" }]);
  });

  it("returns an empty array when data is null", async () => {
    const client = {
      from: () => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        let orderCalls = 0;
        b.order = () => {
          orderCalls += 1;
          if (orderCalls === 2) return Promise.resolve({ data: null, error: null });
          return b;
        };
        return b;
      },
    } as unknown as SupabaseClient;

    const result = await listRegistrations(client);
    expect(result).toEqual([]);
  });

  it("throws with the Supabase error message on query failure", async () => {
    const client = {
      from: () => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        let orderCalls = 0;
        b.order = () => {
          orderCalls += 1;
          if (orderCalls === 2) return Promise.resolve({ data: null, error: { message: "boom" } });
          return b;
        };
        return b;
      },
    } as unknown as SupabaseClient;

    await expect(listRegistrations(client)).rejects.toThrow(/boom/);
  });
});

type Recorded = { table: string; op: string; payload?: unknown };

function makeSaveClient(
  existingIds: string[],
  opts: { deleteError?: string; insertError?: string; upsertError?: string } = {},
) {
  const recorded: Recorded[] = [];
  const client = {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      b.select = () => Promise.resolve({ data: existingIds.map((id) => ({ id })), error: null });
      b.delete = () => b;
      b.in = (_col: string, ids: string[]) => {
        recorded.push({ table, op: "delete", payload: ids });
        return Promise.resolve({ error: opts.deleteError ? { message: opts.deleteError } : null });
      };
      b.insert = (payload: unknown) => {
        recorded.push({ table, op: "insert", payload });
        return Promise.resolve({ error: opts.insertError ? { message: opts.insertError } : null });
      };
      b.upsert = (payload: unknown, upsertOpts?: unknown) => {
        recorded.push({ table, op: "upsert", payload: { rows: payload, opts: upsertOpts } });
        return Promise.resolve({ error: opts.upsertError ? { message: opts.upsertError } : null });
      };
      return b;
    },
  } as unknown as SupabaseClient;
  return { client, recorded };
}

describe("saveRegistrations", () => {
  it("deletes rows missing from the incoming payload, inserts id-less rows, and upserts id-bearing rows separately", async () => {
    const { client, recorded } = makeSaveClient(["r1", "r2"]);
    const rows: TaxRegistrationInput[] = [
      { id: "r1", authority_key: "irs", label: "Federal EIN (FEIN)", number: "12-3456789", display_order: 0 },
      { authority_key: "nc_abc", label: "Permit #", number: "ABC-1", display_order: 0 },
    ];
    await saveRegistrations(client, rows);

    const deleteCall = recorded.find((r) => r.op === "delete");
    expect(deleteCall?.payload).toEqual(["r2"]);

    // Regression guard: the old implementation batched id-less and id-bearing
    // rows into a single .upsert(...), which PostgREST rejects (id=NULL
    // violates the NOT NULL PK). Each write must go to the right endpoint,
    // and the id-less row must never carry a null/undefined `id` key.
    const insertCall = recorded.find((r) => r.op === "insert");
    const insertPayload = insertCall?.payload as Array<Record<string, unknown>>;
    expect(insertPayload).toHaveLength(1);
    expect(insertPayload[0]).toMatchObject({ authority_key: "nc_abc" });
    expect(insertPayload[0]).not.toHaveProperty("id");

    const upsertCall = recorded.find((r) => r.op === "upsert");
    const upsertPayload = upsertCall?.payload as { rows: Array<Record<string, unknown>>; opts: unknown };
    expect(upsertPayload.rows).toHaveLength(1);
    expect(upsertPayload.rows[0]).toMatchObject({ id: "r1", authority_key: "irs" });
    expect(upsertPayload.opts).toMatchObject({ onConflict: "id" });
  });

  it("skips the delete call when nothing needs deleting", async () => {
    const { client, recorded } = makeSaveClient(["r1"]);
    await saveRegistrations(client, [
      { id: "r1", authority_key: "irs", label: "Federal EIN (FEIN)", number: "12-3456789", display_order: 0 },
    ]);
    expect(recorded.some((r) => r.op === "delete")).toBe(false);
  });

  it("skips both insert and upsert calls when rows is empty", async () => {
    const { client, recorded } = makeSaveClient(["r1"]);
    await saveRegistrations(client, []);
    expect(recorded.some((r) => r.op === "insert")).toBe(false);
    expect(recorded.some((r) => r.op === "upsert")).toBe(false);
    expect(recorded.find((r) => r.op === "delete")?.payload).toEqual(["r1"]);
  });

  it("skips the insert call when all rows have an id", async () => {
    const { client, recorded } = makeSaveClient(["r1"]);
    await saveRegistrations(client, [
      { id: "r1", authority_key: "irs", label: "FEIN", number: null, display_order: 0 },
    ]);
    expect(recorded.some((r) => r.op === "insert")).toBe(false);
    expect(recorded.some((r) => r.op === "upsert")).toBe(true);
  });

  it("skips the upsert call when all rows are id-less", async () => {
    const { client, recorded } = makeSaveClient([]);
    await saveRegistrations(client, [
      { authority_key: "nc_abc", label: "Permit #", number: "ABC-1", display_order: 0 },
    ]);
    expect(recorded.some((r) => r.op === "upsert")).toBe(false);
    expect(recorded.some((r) => r.op === "insert")).toBe(true);
  });

  it("throws with the Supabase error message on delete failure", async () => {
    const { client } = makeSaveClient(["r1", "r2"], { deleteError: "delete boom" });
    await expect(
      saveRegistrations(client, [
        { id: "r1", authority_key: "irs", label: "FEIN", number: null, display_order: 0 },
      ]),
    ).rejects.toThrow(/delete boom/);
  });

  it("throws with the Supabase error message on insert failure", async () => {
    const { client } = makeSaveClient([], { insertError: "insert boom" });
    await expect(
      saveRegistrations(client, [
        { authority_key: "nc_abc", label: "Permit #", number: "ABC-1", display_order: 0 },
      ]),
    ).rejects.toThrow(/insert boom/);
  });

  it("throws with the Supabase error message on upsert failure", async () => {
    const { client } = makeSaveClient(["r1"], { upsertError: "upsert boom" });
    await expect(
      saveRegistrations(client, [
        { id: "r1", authority_key: "irs", label: "FEIN", number: null, display_order: 0 },
      ]),
    ).rejects.toThrow(/upsert boom/);
  });
});

describe("BASE_REQUIRED_REGISTRATIONS", () => {
  it("is exactly the universal FEIN requirement", () => {
    expect(BASE_REQUIRED_REGISTRATIONS).toEqual([
      { authorityKey: "irs", registrationKey: "fein", label: "Federal EIN (FEIN)" },
    ]);
  });
});

describe("resolveRequiredRegistrations", () => {
  it("resolves a requirement to its matching (authority_key, key) row, including its id and number", () => {
    const requirements: RequiredRegistration[] = [
      { authorityKey: "irs", registrationKey: "fein", label: "Federal EIN (FEIN)" },
    ];
    const result = resolveRequiredRegistrations(requirements, sampleRegistrations);
    expect(result).toEqual([
      { authorityKey: "irs", registrationKey: "fein", label: "Federal EIN (FEIN)", id: "r1", number: "12-3456789" },
    ]);
  });

  it("resolves to number: null and no id when no matching row exists yet", () => {
    const requirements: RequiredRegistration[] = [
      { authorityKey: "nc_abc", registrationKey: "abc_permit_number", label: "NC ABC Permit Number" },
    ];
    const result = resolveRequiredRegistrations(requirements, sampleRegistrations);
    expect(result).toEqual([
      { authorityKey: "nc_abc", registrationKey: "abc_permit_number", label: "NC ABC Permit Number", id: undefined, number: null },
    ]);
  });

  it("matches by BOTH authority_key and key — a same-authority row with a different key must not match", () => {
    const requirements: RequiredRegistration[] = [
      { authorityKey: "nc_dor", registrationKey: "some_other_key", label: "Something Else" },
    ];
    const result = resolveRequiredRegistrations(requirements, sampleRegistrations);
    expect(result[0].number).toBeNull();
    expect(result[0].id).toBeUndefined();
  });

  it("dedupes requirements sharing the same (authorityKey, registrationKey), keeping the first occurrence's label", () => {
    const requirements: RequiredRegistration[] = [
      { authorityKey: "irs", registrationKey: "fein", label: "Federal EIN (FEIN)" },
      { authorityKey: "irs", registrationKey: "fein", label: "Duplicate Label" },
    ];
    const result = resolveRequiredRegistrations(requirements, sampleRegistrations);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("Federal EIN (FEIN)");
  });
});
