import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildRateMap,
  getTaxRate,
  listTaxRates,
  ncLocalKey,
  ncSalesLineKey,
  ncTransitKey,
  TAX_RATE_KEYS,
  type TaxRate,
} from "./rates";

const sampleRates: TaxRate[] = [
  {
    id: "r1",
    key: "federal_beer_excise",
    name: "Federal Beer Excise Tax",
    category: "excise",
    party_key: "ttb",
    basis: "per_bbl",
    rate: 3.5,
    is_active: true,
  },
  {
    id: "r2",
    key: "nc_dor_beer_excise",
    name: "NC Beer Excise Tax",
    category: "excise",
    party_key: "nc_dor",
    basis: "per_gallon",
    rate: 0.6171,
    is_active: true,
  },
];

describe("key builders", () => {
  it("ncSalesLineKey returns the exact string", () => {
    expect(ncSalesLineKey(4)).toBe("nc_sales_line_4");
    expect(ncSalesLineKey(12)).toBe("nc_sales_line_12");
  });

  it("ncLocalKey returns the exact string", () => {
    expect(ncLocalKey("WAKE")).toBe("nc_local_WAKE");
    expect(ncLocalKey("NEW_HANOVER")).toBe("nc_local_NEW_HANOVER");
  });

  it("ncTransitKey returns the exact string", () => {
    expect(ncTransitKey("WAKE")).toBe("nc_transit_WAKE");
    expect(ncTransitKey("DURHAM")).toBe("nc_transit_DURHAM");
  });

  it("TAX_RATE_KEYS exposes the well-known keys", () => {
    expect(TAX_RATE_KEYS.NC_DOR_BEER_EXCISE).toBe("nc_dor_beer_excise");
    expect(TAX_RATE_KEYS.FEDERAL_BEER_EXCISE).toBe("federal_beer_excise");
    expect(TAX_RATE_KEYS.NC_SALES_STATE).toBe("nc_sales_state");
  });
});

describe("buildRateMap", () => {
  it("collapses rows into a flat key:rate map", () => {
    expect(buildRateMap(sampleRates)).toEqual({
      federal_beer_excise: 3.5,
      nc_dor_beer_excise: 0.6171,
    });
  });

  it("returns an empty object for an empty array", () => {
    expect(buildRateMap([])).toEqual({});
  });
});

describe("listTaxRates", () => {
  it("selects all rows with no filters applied", async () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const client = {
      from: () => {
        const b: Record<string, unknown> = {};
        b.select = (...args: unknown[]) => {
          calls.push({ method: "select", args });
          return b;
        };
        b.eq = (...args: unknown[]) => {
          calls.push({ method: "eq", args });
          return b;
        };
        b.then = (resolve: (v: { data: unknown; error: null }) => unknown) =>
          resolve({ data: sampleRates, error: null });
        return b;
      },
    } as unknown as SupabaseClient;

    const result = await listTaxRates(client);
    expect(result).toEqual(sampleRates);
    expect(calls.some((c) => c.method === "eq")).toBe(false);
  });

  it("filters by category when provided", async () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const client = {
      from: () => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = (...args: unknown[]) => {
          calls.push({ method: "eq", args });
          return b;
        };
        b.then = (resolve: (v: { data: unknown; error: null }) => unknown) =>
          resolve({ data: sampleRates, error: null });
        return b;
      },
    } as unknown as SupabaseClient;

    await listTaxRates(client, { category: "excise" });
    expect(calls).toEqual([{ method: "eq", args: ["category", "excise"] }]);
  });

  it("filters by is_active when activeOnly is set", async () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const client = {
      from: () => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = (...args: unknown[]) => {
          calls.push({ method: "eq", args });
          return b;
        };
        b.then = (resolve: (v: { data: unknown; error: null }) => unknown) =>
          resolve({ data: sampleRates, error: null });
        return b;
      },
    } as unknown as SupabaseClient;

    await listTaxRates(client, { category: "excise", activeOnly: true });
    expect(calls).toEqual([
      { method: "eq", args: ["category", "excise"] },
      { method: "eq", args: ["is_active", true] },
    ]);
  });

  it("returns an empty array when data is null", async () => {
    const client = {
      from: () => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.then = (resolve: (v: { data: unknown; error: null }) => unknown) => resolve({ data: null, error: null });
        return b;
      },
    } as unknown as SupabaseClient;

    const result = await listTaxRates(client);
    expect(result).toEqual([]);
  });

  it("throws with the Supabase error message on query failure", async () => {
    const client = {
      from: () => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.then = (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
          resolve({ data: null, error: { message: "boom" } });
        return b;
      },
    } as unknown as SupabaseClient;

    await expect(listTaxRates(client)).rejects.toThrow(/boom/);
  });
});

describe("getTaxRate", () => {
  it("returns the active row's rate for the key", async () => {
    const recorded: { col: string; value: unknown }[] = [];
    const client = {
      from: () => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = (col: string, value: unknown) => {
          recorded.push({ col, value });
          return b;
        };
        b.maybeSingle = () => Promise.resolve({ data: { rate: 0.6171 }, error: null });
        return b;
      },
    } as unknown as SupabaseClient;

    const result = await getTaxRate(client, "nc_dor_beer_excise");
    expect(result).toBe(0.6171);
    expect(recorded).toEqual([
      { col: "key", value: "nc_dor_beer_excise" },
      { col: "is_active", value: true },
    ]);
  });

  it("returns null when no active row matches", async () => {
    const client = {
      from: () => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = () => b;
        b.maybeSingle = () => Promise.resolve({ data: null, error: null });
        return b;
      },
    } as unknown as SupabaseClient;

    const result = await getTaxRate(client, "missing_key");
    expect(result).toBeNull();
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

    await expect(getTaxRate(client, "nc_dor_beer_excise")).rejects.toThrow(/boom/);
  });
});
