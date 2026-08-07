import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getEntityProfile, putEntityProfile, ENTITY_PROFILE_SCHEMA, type EntityProfileValues } from "./entity";

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

describe("ENTITY_PROFILE_SCHEMA", () => {
  it("no longer declares the fields that moved to tax_legal_representative, or the dropped state_of_domicile", () => {
    const keys = ENTITY_PROFILE_SCHEMA.map((f) => f.key);
    expect(keys).not.toContain("ssn");
    expect(keys).not.toContain("contact_name");
    expect(keys).not.toContain("contact_email");
    expect(keys).not.toContain("state_of_domicile");
  });
});

describe("getEntityProfile", () => {
  it("returns an empty object when no row exists yet", async () => {
    const { client } = makeClient(null);
    const result = await getEntityProfile(client);
    expect(result).toEqual({});
  });

  it("returns only non-null schema-key columns coerced to string, ignoring legacy/removed columns still present on the row", async () => {
    const { client } = makeClient({
      id: true,
      legal_name: "TPB LLC",
      fein: "12-345", // legacy column, never part of ENTITY_PROFILE_SCHEMA
      ssn: "999", // removed from schema (moved to tax_legal_representative) — must not be surfaced even if the column briefly still has data
      contact_name: "Old Contact",
      contact_email: "old@example.com",
      contact_phone: null,
      fax_number: null,
      address_line1: null,
      address_line2: null,
      city: null,
      state: null,
      postal_code: null,
      updated_at: "2026-01-01T00:00:00Z",
    });
    const result = await getEntityProfile(client);
    expect(result).toEqual({ legal_name: "TPB LLC" });
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
  it("merges submitted values onto the existing row and upserts on id", async () => {
    const { client, recorded } = makeClient({ id: true, legal_name: "Old", updated_at: "2026-01-01T00:00:00Z" });
    await putEntityProfile(client, { legal_name: "New" });

    expect(recorded).toHaveLength(1);
    expect(recorded[0].table).toBe("tax_entity_profile");
    expect(recorded[0].opts).toEqual({ onConflict: "id" });
    expect(recorded[0].payload).toMatchObject({
      id: true,
      legal_name: "New",
    });
  });

  it("treats a blank submitted value as leave-unchanged", async () => {
    const { client, recorded } = makeClient({ id: true, trade_name: "Existing DBA", updated_at: "2026-01-01T00:00:00Z" });
    await putEntityProfile(client, { trade_name: "", legal_name: "New" });
    expect((recorded[0].payload as EntityProfileValues).trade_name).toBe("Existing DBA");
  });

  it("throws with the Supabase error message on upsert failure", async () => {
    const { client } = makeClient(null, "constraint violation");
    await expect(putEntityProfile(client, { legal_name: "New" })).rejects.toThrow(/constraint violation/);
  });
});
