/**
 * Covers the mutable half of lib/tax/obligations.ts — the portal link. The
 * lookup table's immutable half (which obligations exist, and that each has a
 * template) is pinned separately in obligations.test.ts.
 */
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { validateFilingUrl, setFilingUrl, buildFilingUrlMap } from "./obligations";

describe("validateFilingUrl", () => {
  it("accepts an absent or blank link — the column is nullable for paper filings", () => {
    expect(validateFilingUrl(null)).toBeNull();
    expect(validateFilingUrl(undefined)).toBeNull();
    expect(validateFilingUrl("   ")).toBeNull();
  });

  it("accepts http and https portal links", () => {
    expect(validateFilingUrl("https://eservices.dor.nc.gov/wheres")).toBeNull();
    expect(validateFilingUrl("http://example.gov/file")).toBeNull();
  });

  it("rejects a link with no http(s) scheme, matching the DB CHECK", () => {
    expect(validateFilingUrl("eservices.dor.nc.gov")).toBe("Filing link must start with http:// or https://.");
    expect(validateFilingUrl("ftp://dor.nc.gov")).toBe("Filing link must start with http:// or https://.");
  });

  it("rejects a link containing whitespace, which the CHECK's regex also refuses", () => {
    expect(validateFilingUrl("https://dor.nc.gov/a b")).toBe("Filing link must not contain spaces.");
  });
});

function stubClient(row: unknown) {
  const recorded: { payload?: unknown; eq?: unknown[] } = {};
  const client = {
    from: () => {
      const b: Record<string, unknown> = {};
      b.update = (payload: unknown) => {
        recorded.payload = payload;
        return b;
      };
      b.select = () => b;
      b.order = () => b;
      b.eq = (col: string, val: unknown) => {
        recorded.eq = [col, val];
        return b;
      };
      b.maybeSingle = () => Promise.resolve({ data: row, error: null });
      b.then = (resolve: (v: unknown) => void) => resolve({ data: row, error: null });
      return b;
    },
  } as unknown as SupabaseClient;
  return { client, recorded };
}

describe("setFilingUrl", () => {
  it("updates the addressed obligation row and returns it", async () => {
    const row = {
      key: "nc_dor_sales_use",
      authority_key: "nc_dor",
      label: "NC DOR — Sales & Use Tax",
      display_order: 0,
      filing_url: "https://eservices.dor.nc.gov/",
    };
    const { client, recorded } = stubClient(row);

    const result = await setFilingUrl(client, "nc_dor_sales_use", "https://eservices.dor.nc.gov/");

    expect(result).toEqual(row);
    expect(recorded.payload).toEqual({ filing_url: "https://eservices.dor.nc.gov/" });
    expect(recorded.eq).toEqual(["key", "nc_dor_sales_use"]);
  });

  it("clears the link when passed null", async () => {
    const { client, recorded } = stubClient({ key: "k", authority_key: "a", label: "l", display_order: 0, filing_url: null });
    await setFilingUrl(client, "k", null);
    expect(recorded.payload).toEqual({ filing_url: null });
  });

  it("throws rather than creating a row for an unknown obligation", async () => {
    const { client } = stubClient(null);
    await expect(setFilingUrl(client, "not_an_obligation", "https://x.gov")).rejects.toThrow(
      'Unknown filing obligation "not_an_obligation"',
    );
  });
});

describe("buildFilingUrlMap", () => {
  it("keys each obligation's link by filing_key, preserving nulls", async () => {
    const rows = [
      { key: "nc_dor_sales_use", authority_key: "nc_dor", label: "a", display_order: 0, filing_url: "https://x.gov" },
      { key: "wake_county_food_beverage", authority_key: "wake_county", label: "b", display_order: 1, filing_url: null },
    ];
    const { client } = stubClient(rows);

    expect(await buildFilingUrlMap(client)).toEqual({
      nc_dor_sales_use: "https://x.gov",
      wake_county_food_beverage: null,
    });
  });
});
