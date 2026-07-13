import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listAuthorities, updateRegistration, type TaxAuthority } from "./authorities";

const sampleAuthorities: TaxAuthority[] = [
  { key: "nc_dor", label: "NC DOR", kind: "filing", registration_number: "123", display_order: 1 },
  { key: "ttb", label: "TTB", kind: "excise", registration_number: null, display_order: 2 },
];

describe("listAuthorities", () => {
  it("returns rows ordered by display_order", async () => {
    const recorded: { col: string }[] = [];
    const client = {
      from: () => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.order = (col: string) => {
          recorded.push({ col });
          return Promise.resolve({ data: sampleAuthorities, error: null });
        };
        return b;
      },
    } as unknown as SupabaseClient;

    const result = await listAuthorities(client);
    expect(result).toEqual(sampleAuthorities);
    expect(recorded).toEqual([{ col: "display_order" }]);
  });

  it("returns an empty array when data is null", async () => {
    const client = {
      from: () => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.order = () => Promise.resolve({ data: null, error: null });
        return b;
      },
    } as unknown as SupabaseClient;

    const result = await listAuthorities(client);
    expect(result).toEqual([]);
  });

  it("throws with the Supabase error message on query failure", async () => {
    const client = {
      from: () => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.order = () => Promise.resolve({ data: null, error: { message: "boom" } });
        return b;
      },
    } as unknown as SupabaseClient;

    await expect(listAuthorities(client)).rejects.toThrow(/boom/);
  });
});

describe("updateRegistration", () => {
  it("normalizes an empty string to null", async () => {
    const recorded: { table: string; payload: unknown; eqArgs: unknown[] }[] = [];
    const client = {
      from: (table: string) => ({
        update: (payload: unknown) => ({
          eq: (col: string, val: string) => {
            recorded.push({ table, payload, eqArgs: [col, val] });
            return Promise.resolve({ error: null });
          },
        }),
      }),
    } as unknown as SupabaseClient;

    await updateRegistration(client, "nc_dor", "");
    expect(recorded[0].table).toBe("tax_authorities");
    expect(recorded[0].payload).toMatchObject({ registration_number: null, updated_at: expect.any(String) });
    expect(recorded[0].eqArgs).toEqual(["key", "nc_dor"]);
  });

  it("passes through a non-empty registration number", async () => {
    const recorded: { payload: unknown }[] = [];
    const client = {
      from: () => ({
        update: (payload: unknown) => ({
          eq: () => {
            recorded.push({ payload });
            return Promise.resolve({ error: null });
          },
        }),
      }),
    } as unknown as SupabaseClient;

    await updateRegistration(client, "nc_dor", "123");
    expect(recorded[0].payload).toMatchObject({ registration_number: "123" });
  });

  it("throws with the Supabase error message on update failure", async () => {
    const client = {
      from: () => ({
        update: () => ({
          eq: () => Promise.resolve({ error: { message: "boom" } }),
        }),
      }),
    } as unknown as SupabaseClient;

    await expect(updateRegistration(client, "nc_dor", "123")).rejects.toThrow(/boom/);
  });
});
