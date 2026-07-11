import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getNetTermsDays, addDaysIso } from "./invoiceTerms";

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

describe("addDaysIso", () => {
  it("adds days within a month", () => {
    expect(addDaysIso("2026-07-10", 14)).toBe("2026-07-24");
  });

  it("rolls over a month boundary", () => {
    expect(addDaysIso("2026-01-31", 1)).toBe("2026-02-01");
  });

  it("rolls over a year boundary", () => {
    expect(addDaysIso("2026-12-25", 10)).toBe("2027-01-04");
  });
});
