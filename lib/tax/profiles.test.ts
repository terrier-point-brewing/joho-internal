import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FieldSpec, TaxFilingProfileValues } from "./types";
import { getProfile, putProfile, maskSensitive, pickSensitiveValues } from "./profiles";

const sensitiveSchema: FieldSpec[] = [
  { key: "contact_name", label: "Contact name", type: "text" },
  { key: "fein", label: "Federal EIN", type: "text" },
  { key: "ssn", label: "SSN", type: "text", sensitive: true },
];

type Recorded = { table: string; op: string; payload?: unknown; opts?: unknown };

function makeClient(existingValues: TaxFilingProfileValues | null, upsertError?: string) {
  const recorded: Recorded[] = [];
  const client = {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = () =>
        Promise.resolve({ data: existingValues === null ? null : { values: existingValues }, error: null });
      b.upsert = (payload: unknown, opts: unknown) => {
        recorded.push({ table, op: "upsert", payload, opts });
        return Promise.resolve({ error: upsertError ? { message: upsertError } : null });
      };
      return b;
    },
  } as unknown as SupabaseClient;
  return { client, recorded };
}

describe("getProfile", () => {
  it("returns the stored values when a profile row exists", async () => {
    const { client } = makeClient({ contact_name: "Jamie", fein: "12-3456789" });
    const result = await getProfile(client, "nc_dor_sales_use");
    expect(result).toEqual({ contact_name: "Jamie", fein: "12-3456789" });
  });

  it("returns an empty object when no profile row exists yet", async () => {
    const { client } = makeClient(null);
    const result = await getProfile(client, "nc_dor_sales_use");
    expect(result).toEqual({});
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
    await expect(getProfile(client, "nc_dor_sales_use")).rejects.toThrow(/boom/);
  });
});

describe("putProfile", () => {
  it("upserts merged values on filing_key", async () => {
    const { client, recorded } = makeClient({ contact_name: "Jamie", fein: "12-3456789" });
    await putProfile(client, "nc_dor_sales_use", { contact_name: "Alex" });

    expect(recorded).toHaveLength(1);
    expect(recorded[0].table).toBe("tax_filing_profiles");
    expect(recorded[0].opts).toEqual({ onConflict: "filing_key" });
    expect(recorded[0].payload).toMatchObject({
      filing_key: "nc_dor_sales_use",
      values: { contact_name: "Alex", fein: "12-3456789" },
    });
  });

  it("preserves the existing sensitive value when the submitted value is blank (masked round-trip)", async () => {
    const { client, recorded } = makeClient({ ssn: "123-45-6789", contact_name: "Jamie" });
    // Simulates the UI submitting a masked form: it never sends the real SSN,
    // only a blank string for the field it isn't changing.
    await putProfile(client, "nc_dor_sales_use", { ssn: "", contact_name: "Alex" });

    expect(recorded[0].payload).toMatchObject({
      values: { ssn: "123-45-6789", contact_name: "Alex" },
    });
  });

  it("creates a new row with just the submitted values when no profile exists yet", async () => {
    const { client, recorded } = makeClient(null);
    await putProfile(client, "nc_dor_sales_use", { contact_name: "Jamie" });

    expect(recorded[0].payload).toMatchObject({
      filing_key: "nc_dor_sales_use",
      values: { contact_name: "Jamie" },
    });
  });

  it("throws with the Supabase error message on upsert failure", async () => {
    const { client } = makeClient({}, "constraint violation");
    await expect(putProfile(client, "nc_dor_sales_use", { contact_name: "Jamie" })).rejects.toThrow(
      /constraint violation/,
    );
  });
});

describe("maskSensitive", () => {
  it("masks a non-empty sensitive field as \"present\"", () => {
    const result = maskSensitive({ ssn: "123-45-6789", contact_name: "Jamie" }, sensitiveSchema);
    expect(result.ssn).toBe("present");
  });

  it("masks a missing/empty sensitive field as \"absent\"", () => {
    const result = maskSensitive({ contact_name: "Jamie" }, sensitiveSchema);
    expect(result.ssn).toBe("absent");

    const resultBlank = maskSensitive({ ssn: "", contact_name: "Jamie" }, sensitiveSchema);
    expect(resultBlank.ssn).toBe("absent");
  });

  it("passes non-sensitive fields through unchanged", () => {
    const result = maskSensitive({ contact_name: "Jamie", fein: "12-3456789", ssn: "123-45-6789" }, sensitiveSchema);
    expect(result.contact_name).toBe("Jamie");
    expect(result.fein).toBe("12-3456789");
  });
});

describe("pickSensitiveValues", () => {
  it("returns the real value for a non-empty sensitive field", () => {
    const result = pickSensitiveValues({ ssn: "123-45-6789", contact_name: "Jamie" }, sensitiveSchema);
    expect(result).toEqual({ ssn: "123-45-6789" });
  });

  it("omits a sensitive field with no stored value", () => {
    expect(pickSensitiveValues({ contact_name: "Jamie" }, sensitiveSchema)).toEqual({});
    expect(pickSensitiveValues({ ssn: "", contact_name: "Jamie" }, sensitiveSchema)).toEqual({});
  });

  it("never includes non-sensitive fields, even though they're already visible via the masked GET", () => {
    const result = pickSensitiveValues(
      { contact_name: "Jamie", fein: "12-3456789", ssn: "123-45-6789" },
      sensitiveSchema,
    );
    expect(result).toEqual({ ssn: "123-45-6789" });
  });
});
