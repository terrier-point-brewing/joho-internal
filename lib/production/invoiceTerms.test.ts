import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getNetTermsDays } from "./invoiceTerms";

/** Stub for supabase.from("system_settings").select("value").eq("key",…).single(). */
function settingsStub(result: { data: { value: number } | null; error: unknown }): SupabaseClient {
  return {
    from() {
      return {
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve(result),
          }),
        }),
      };
    },
  } as unknown as SupabaseClient;
}

describe("getNetTermsDays", () => {
  it("returns the configured value when the setting exists", async () => {
    const days = await getNetTermsDays(settingsStub({ data: { value: 14 }, error: null }), "deposit");
    expect(days).toBe(14);
  });

  it("defaults to 30 when the setting row is missing", async () => {
    const days = await getNetTermsDays(settingsStub({ data: null, error: null }), "export");
    expect(days).toBe(30);
  });

  it("defaults to 30 when the query errors", async () => {
    const days = await getNetTermsDays(settingsStub({ data: null, error: { message: "boom" } }), "export");
    expect(days).toBe(30);
  });
});
