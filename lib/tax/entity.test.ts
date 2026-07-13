import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getEntityProfile, putEntityProfile, ENTITY_PROFILE_SCHEMA, type EntityProfileValues } from "./entity";
import { maskSensitive } from "./profiles";

type Recorded = { table: string; op: string; payload?: unknown; opts?: unknown };

function makeClient(row: Record<string, unknown> | null, upsertError?: string) {
  const recorded: Recorded[] = [];
  const client = {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = () => Promise.resolve({ data: row, error: null });
      b.upsert = (payload: unknown, opts: unknown) => {
        recorded.push({ table, op: "upsert", payload, opts });
        return Promise.resolve({ error: upsertError ? { message: upsertError } : null });
      };
      return b;
    },
  } as unknown as SupabaseClient;
  return { client, recorded };
}

describe("getEntityProfile", () => {
  it("returns an empty object when no row exists yet", async () => {
    const { client } = makeClient(null);
    const result = await getEntityProfile(client);
    expect(result).toEqual({});
  });

  it("returns only non-null schema-key columns coerced to string", async () => {
    const { client } = makeClient({
      id: true,
      legal_name: "TPB LLC",
      fein: "12-345",
      ssn: null,
      contact_name: null,
      contact_email: null,
      contact_phone: null,
      address_line1: null,
      address_line2: null,
      city: null,
      state: null,
      postal_code: null,
      updated_at: "2026-01-01T00:00:00Z",
    });
    const result = await getEntityProfile(client);
    expect(result).toEqual({ legal_name: "TPB LLC", fein: "12-345" });
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
    await expect(getEntityProfile(client)).rejects.toThrow(/boom/);
  });
});

describe("putEntityProfile", () => {
  it("preserves an existing sensitive value when the submitted value is blank, and upserts on id", async () => {
    const { client, recorded } = makeClient({ id: true, ssn: "999", updated_at: "2026-01-01T00:00:00Z" });
    await putEntityProfile(client, { ssn: "", legal_name: "New" });

    expect(recorded).toHaveLength(1);
    expect(recorded[0].table).toBe("tax_entity_profile");
    expect(recorded[0].opts).toEqual({ onConflict: "id" });
    expect(recorded[0].payload).toMatchObject({
      id: true,
      ssn: "999",
      legal_name: "New",
      updated_at: expect.any(String),
    });
  });

  it("throws with the Supabase error message on upsert failure", async () => {
    const { client } = makeClient(null, "constraint violation");
    await expect(putEntityProfile(client, { legal_name: "New" })).rejects.toThrow(/constraint violation/);
  });
});

describe("maskSensitive on ENTITY_PROFILE_SCHEMA", () => {
  it("masks ssn as present/absent but leaves fein visible", () => {
    const values: EntityProfileValues = { fein: "12-345", ssn: "999", legal_name: "X" };
    const result = maskSensitive(values, ENTITY_PROFILE_SCHEMA);
    expect(result.ssn).toBe("present");
    expect(result.fein).toBe("12-345");
    expect(result.legal_name).toBe("X");
  });
});
