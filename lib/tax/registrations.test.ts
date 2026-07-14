import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  reconcileRegistrations,
  listRegistrations,
  saveRegistrations,
  type TaxRegistration,
  type TaxRegistrationInput,
} from "./registrations";

const sampleRegistrations: TaxRegistration[] = [
  { id: "r1", authority_key: "irs", label: "Federal EIN (FEIN)", number: "12-3456789", display_order: 0 },
  { id: "r2", authority_key: "nc_dor", label: "Account / License #", number: "NC-999", display_order: 0 },
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

function makeSaveClient(existingIds: string[], opts: { deleteError?: string; upsertError?: string } = {}) {
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
      b.upsert = (payload: unknown) => {
        recorded.push({ table, op: "upsert", payload });
        return Promise.resolve({ error: opts.upsertError ? { message: opts.upsertError } : null });
      };
      return b;
    },
  } as unknown as SupabaseClient;
  return { client, recorded };
}

describe("saveRegistrations", () => {
  it("deletes rows missing from the incoming payload and upserts the rest", async () => {
    const { client, recorded } = makeSaveClient(["r1", "r2"]);
    const rows: TaxRegistrationInput[] = [
      { id: "r1", authority_key: "irs", label: "Federal EIN (FEIN)", number: "12-3456789", display_order: 0 },
      { authority_key: "nc_abc", label: "Permit #", number: "ABC-1", display_order: 0 },
    ];
    await saveRegistrations(client, rows);

    const deleteCall = recorded.find((r) => r.op === "delete");
    expect(deleteCall?.payload).toEqual(["r2"]);

    const upsertCall = recorded.find((r) => r.op === "upsert");
    const payload = upsertCall?.payload as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(2);
    expect(payload[0]).toMatchObject({ id: "r1", authority_key: "irs", updated_at: expect.any(String) });
    expect(payload[1]).toMatchObject({ authority_key: "nc_abc", updated_at: expect.any(String) });
  });

  it("skips the delete call when nothing needs deleting", async () => {
    const { client, recorded } = makeSaveClient(["r1"]);
    await saveRegistrations(client, [
      { id: "r1", authority_key: "irs", label: "Federal EIN (FEIN)", number: "12-3456789", display_order: 0 },
    ]);
    expect(recorded.some((r) => r.op === "delete")).toBe(false);
  });

  it("skips the upsert call when rows is empty", async () => {
    const { client, recorded } = makeSaveClient(["r1"]);
    await saveRegistrations(client, []);
    expect(recorded.some((r) => r.op === "upsert")).toBe(false);
    expect(recorded.find((r) => r.op === "delete")?.payload).toEqual(["r1"]);
  });

  it("throws with the Supabase error message on delete failure", async () => {
    const { client } = makeSaveClient(["r1", "r2"], { deleteError: "delete boom" });
    await expect(
      saveRegistrations(client, [
        { id: "r1", authority_key: "irs", label: "FEIN", number: null, display_order: 0 },
      ]),
    ).rejects.toThrow(/delete boom/);
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
