import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listAuthorities, type TaxAuthority } from "./authorities";

const sampleAuthorities: TaxAuthority[] = [
  { key: "nc_dor", label: "NC DOR", display_order: 1 },
  { key: "ttb", label: "TTB", display_order: 2 },
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
