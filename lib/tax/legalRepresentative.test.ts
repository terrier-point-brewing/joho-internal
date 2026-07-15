import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getLegalRepresentative,
  putLegalRepresentative,
  LEGAL_REPRESENTATIVE_SCHEMA,
  type LegalRepresentativeValues,
} from "./legalRepresentative";
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

describe("getLegalRepresentative", () => {
  it("returns an empty object when no row exists yet", async () => {
    const { client } = makeClient(null);
    const result = await getLegalRepresentative(client);
    expect(result).toEqual({});
  });

  it("returns only non-null schema-key columns coerced to string", async () => {
    const { client } = makeClient({
      id: true,
      name: "Weining Liao",
      title: null,
      phone: null,
      email: null,
      ssn: null,
      address_line1: null,
      address_line2: null,
      city: null,
      state: "NC",
      postal_code: null,
      updated_at: "2026-01-01T00:00:00Z",
    });
    const result = await getLegalRepresentative(client);
    expect(result).toEqual({ name: "Weining Liao", state: "NC" });
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
    await expect(getLegalRepresentative(client)).rejects.toThrow(/boom/);
  });
});

describe("putLegalRepresentative", () => {
  it("preserves an existing sensitive value when the submitted value is blank, and upserts on id", async () => {
    const { client, recorded } = makeClient({ id: true, ssn: "999", updated_at: "2026-01-01T00:00:00Z" });
    await putLegalRepresentative(client, { ssn: "", name: "New Name" });

    expect(recorded).toHaveLength(1);
    expect(recorded[0].table).toBe("tax_legal_representative");
    expect(recorded[0].opts).toEqual({ onConflict: "id" });
    expect(recorded[0].payload).toMatchObject({
      id: true,
      ssn: "999",
      name: "New Name",
      updated_at: expect.any(String),
    });
  });

  it("throws with the Supabase error message on upsert failure", async () => {
    const { client } = makeClient(null, "constraint violation");
    await expect(putLegalRepresentative(client, { name: "New" })).rejects.toThrow(/constraint violation/);
  });
});

describe("maskSensitive on LEGAL_REPRESENTATIVE_SCHEMA", () => {
  it("masks ssn as present/absent and passes through non-schema fields unchanged", () => {
    const values: LegalRepresentativeValues = { ssn: "999", name: "X" };
    const result = maskSensitive(values, LEGAL_REPRESENTATIVE_SCHEMA);
    expect(result.ssn).toBe("present");
    expect(result.name).toBe("X");
  });
});
