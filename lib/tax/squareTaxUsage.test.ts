import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listSquareTaxUsage } from "./squareTaxUsage";

/**
 * Stubs the two `.select(...)` chains listSquareTaxUsage issues, keyed by table.
 * Both chains terminate on `.in(...)`, so that's where the awaited value lives.
 */
function stubSb(tables: {
  tax_schedules?: { party_key: string }[];
  tax_filing_profiles?: { party_key: string; values: Record<string, string> | null }[];
  error?: { table: string; message: string };
}): SupabaseClient {
  return {
    from(table: string) {
      const result = tables.error?.table === table
        ? { data: null, error: { message: tables.error.message } }
        : { data: tables[table as "tax_schedules" | "tax_filing_profiles"] ?? [], error: null };
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => Promise.resolve(result),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

const GENERAL = "ADD7EKQD2KN72NOYVUWHU34J";
const FOOD_BEV = "ARI25PLSGLDVIBUQITKTRNSX";

describe("listSquareTaxUsage", () => {
  it("counts every active filing referencing a tax, including the same tax used by two parties", async () => {
    const usage = await listSquareTaxUsage(stubSb({
      tax_schedules: [{ party_key: "nc_dor_sales_use" }, { party_key: "wake_county_food_beverage" }],
      tax_filing_profiles: [
        { party_key: "nc_dor_sales_use", values: { general_sales_tax_id: GENERAL } },
        {
          party_key: "wake_county_food_beverage",
          values: { food_beverage_tax_id: FOOD_BEV, general_sales_tax_id: GENERAL },
        },
      ],
    }));

    // The duplicate the column exists to surface: one Square tax, two returns.
    expect(usage.get(GENERAL)).toHaveLength(2);
    expect(usage.get(GENERAL)?.map((r) => r.party_key).sort()).toEqual([
      "nc_dor_sales_use",
      "wake_county_food_beverage",
    ]);
    expect(usage.get(FOOD_BEV)).toEqual([
      {
        party_key: "wake_county_food_beverage",
        party_label: "Wake County — Prepared Food & Beverage Tax",
        field_label: "Square Prepared Food & Beverage Tax",
      },
    ]);
  });

  it("ignores a party whose schedules are all inactive", async () => {
    // The stub returns only what an `active = true` filter would have matched.
    const usage = await listSquareTaxUsage(stubSb({
      tax_schedules: [{ party_key: "wake_county_food_beverage" }],
      tax_filing_profiles: [
        { party_key: "nc_dor_sales_use", values: { general_sales_tax_id: GENERAL } },
        { party_key: "wake_county_food_beverage", values: { food_beverage_tax_id: FOOD_BEV } },
      ],
    }));

    expect(usage.has(GENERAL)).toBe(false);
    expect(usage.get(FOOD_BEV)).toHaveLength(1);
  });

  it("omits taxes with no reference rather than mapping them to an empty list", async () => {
    const usage = await listSquareTaxUsage(stubSb({
      tax_schedules: [{ party_key: "nc_dor_sales_use" }],
      tax_filing_profiles: [{ party_key: "nc_dor_sales_use", values: {} }],
    }));

    expect(usage.size).toBe(0);
  });

  it("skips a blank stored value instead of counting an empty tax id", async () => {
    const usage = await listSquareTaxUsage(stubSb({
      tax_schedules: [{ party_key: "wake_county_food_beverage" }],
      tax_filing_profiles: [
        { party_key: "wake_county_food_beverage", values: { food_beverage_tax_id: "", general_sales_tax_id: GENERAL } },
      ],
    }));

    expect(usage.has("")).toBe(false);
    expect(usage.get(GENERAL)).toHaveLength(1);
  });

  it("tolerates a party with no stored profile at all", async () => {
    const usage = await listSquareTaxUsage(stubSb({
      tax_schedules: [{ party_key: "nc_dor_sales_use" }],
      tax_filing_profiles: [],
    }));

    expect(usage.size).toBe(0);
  });

  it("throws rather than under-reporting when a query fails", async () => {
    await expect(listSquareTaxUsage(stubSb({
      tax_schedules: [{ party_key: "nc_dor_sales_use" }],
      error: { table: "tax_filing_profiles", message: "boom" },
    }))).rejects.toThrow("boom");
  });
});
