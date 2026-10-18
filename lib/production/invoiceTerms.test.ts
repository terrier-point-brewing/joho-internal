import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getNetTermsDays, invoiceDraftDates, isValidNetTermsDays, netTermsLabel } from "./invoiceTerms";

/** Stub for supabase.from("system_settings").select("value").eq("key",…).single(). */
function settingsStub(result: { data: { value: unknown } | null; error: unknown }): SupabaseClient {
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
    expect(await getNetTermsDays(settingsStub({ data: { value: 14 }, error: null }), "deposit")).toBe(14);
  });

  it("allows 0 — due on receipt", async () => {
    expect(await getNetTermsDays(settingsStub({ data: { value: 0 }, error: null }), "export")).toBe(0);
  });

  it("defaults to 30 when the setting row is missing", async () => {
    expect(await getNetTermsDays(settingsStub({ data: null, error: null }), "export")).toBe(30);
  });

  it("defaults to 30 when the query errors", async () => {
    expect(await getNetTermsDays(settingsStub({ data: null, error: { message: "boom" } }), "export")).toBe(30);
  });

  it("defaults to 30 when the stored value is not a valid day count", async () => {
    expect(await getNetTermsDays(settingsStub({ data: { value: "14" }, error: null }), "export")).toBe(30);
    expect(await getNetTermsDays(settingsStub({ data: { value: -3 }, error: null }), "export")).toBe(30);
  });
});

describe("invoiceDraftDates", () => {
  // 2026-10-18 23:30 UTC is still 2026-10-18 in the brewery's timezone (America/New_York).
  const now = new Date("2026-10-18T23:30:00Z");

  it("adds the configured terms to the brewery-local draft date", async () => {
    const d = await invoiceDraftDates(settingsStub({ data: { value: 14 }, error: null }), "deposit", now);
    expect(d).toEqual({ netTermsDays: 14, draftDate: "2026-10-18", dueDate: "2026-11-01" });
  });

  it("due on receipt makes the due date the draft date", async () => {
    const d = await invoiceDraftDates(settingsStub({ data: { value: 0 }, error: null }), "export", now);
    expect(d.dueDate).toBe(d.draftDate);
  });

  it("does not let a UTC evening roll the draft date forward", async () => {
    const d = await invoiceDraftDates(settingsStub({ data: { value: 30 }, error: null }), "export", new Date("2026-10-19T02:30:00Z"));
    expect(d.draftDate).toBe("2026-10-18");
  });
});

describe("terms validation and label", () => {
  it("accepts integers from 0 to 365 only", () => {
    expect(isValidNetTermsDays(0)).toBe(true);
    expect(isValidNetTermsDays(365)).toBe(true);
    expect(isValidNetTermsDays(366)).toBe(false);
    expect(isValidNetTermsDays(1.5)).toBe(false);
    expect(isValidNetTermsDays("14")).toBe(false);
  });

  it("labels 0 as due on receipt", () => {
    expect(netTermsLabel(0)).toBe("Due on receipt");
    expect(netTermsLabel(14)).toBe("Net 14");
  });
});
