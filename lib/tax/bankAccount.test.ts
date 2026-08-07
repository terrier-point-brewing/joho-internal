import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getBankAccount,
  putBankAccount,
  bankAccountTypeLabel,
  BANK_ACCOUNT_SCHEMA,
  type BankAccountValues,
} from "./bankAccount";
import { maskSensitive, pickSensitiveValues } from "./profiles";

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

describe("getBankAccount", () => {
  it("returns an empty object when no row exists yet", async () => {
    const { client } = makeClient(null);
    const result = await getBankAccount(client);
    expect(result).toEqual({});
  });

  it("returns only non-null schema-key columns coerced to string", async () => {
    const { client } = makeClient({
      id: true,
      account_name: "Operating",
      account_type: "business_checking",
      account_holder: null,
      routing_number: "021000021",
      account_number: null,
      updated_at: "2026-01-01T00:00:00Z",
    });
    const result = await getBankAccount(client);
    expect(result).toEqual({
      account_name: "Operating",
      account_type: "business_checking",
      routing_number: "021000021",
    });
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
    await expect(getBankAccount(client)).rejects.toThrow(/boom/);
  });
});

describe("putBankAccount", () => {
  it("preserves an existing sensitive value when the submitted value is blank, and upserts on id", async () => {
    const { client, recorded } = makeClient({
      id: true,
      routing_number: "021000021",
      account_number: "999",
      updated_at: "2026-01-01T00:00:00Z",
    });
    await putBankAccount(client, { account_number: "", account_name: "New Name" });

    expect(recorded).toHaveLength(1);
    expect(recorded[0].table).toBe("tax_bank_account");
    expect(recorded[0].opts).toEqual({ onConflict: "id" });
    expect(recorded[0].payload).toMatchObject({
      id: true,
      routing_number: "021000021",
      account_number: "999",
      account_name: "New Name",
    });
  });

  it("throws with the Supabase error message on upsert failure", async () => {
    const { client } = makeClient(null, "constraint violation");
    await expect(putBankAccount(client, { account_name: "New" })).rejects.toThrow(/constraint violation/);
  });
});

describe("maskSensitive / pickSensitiveValues on BANK_ACCOUNT_SCHEMA", () => {
  it("masks routing/account numbers as present/absent and passes non-sensitive fields through unchanged", () => {
    const values: BankAccountValues = { routing_number: "021000021", account_number: "999", account_name: "Operating" };
    const masked = maskSensitive(values, BANK_ACCOUNT_SCHEMA);
    expect(masked.routing_number).toBe("present");
    expect(masked.account_number).toBe("present");
    expect(masked.account_name).toBe("Operating");
  });

  it("reveals only the sensitive fields' real values", () => {
    const values: BankAccountValues = { routing_number: "021000021", account_number: "999", account_name: "Operating" };
    expect(pickSensitiveValues(values, BANK_ACCOUNT_SCHEMA)).toEqual({
      routing_number: "021000021",
      account_number: "999",
    });
  });
});

describe("bankAccountTypeLabel", () => {
  it("resolves a known account_type value to its display label", () => {
    expect(bankAccountTypeLabel("business_checking")).toBe("Business Checking");
    expect(bankAccountTypeLabel("personal_savings")).toBe("Personal Savings");
  });

  it("falls back to an em dash for an unknown or missing account_type", () => {
    expect(bankAccountTypeLabel(undefined)).toBe("—");
    expect(bankAccountTypeLabel("checking")).toBe("—");
  });
});
