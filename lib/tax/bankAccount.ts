/**
 * Singleton bank account storage (`tax_bank_account`) — the account filings
 * are paid from/refunded to, distinct from `tax_entity_profile` (the
 * business itself) and `tax_legal_representative` (who signs). Same
 * singleton (`id = true`) and blank-means-leave-unchanged merge convention
 * as those two — the UI never round-trips the real value for the
 * `sensitive` routing/account number fields, so a blank submitted value
 * must not wipe the stored one.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FieldSpec } from "./types";

export const BANK_ACCOUNT_TYPES: { value: string; label: string }[] = [
  { value: "personal_checking", label: "Personal Checking" },
  { value: "business_checking", label: "Business Checking" },
  { value: "personal_savings", label: "Personal Savings" },
  { value: "business_savings", label: "Business Savings" },
];

export const BANK_ACCOUNT_SCHEMA: FieldSpec[] = [
  { key: "account_name", label: "Name of account", type: "text" },
  { key: "account_type", label: "Account type", type: "select", options: BANK_ACCOUNT_TYPES },
  { key: "account_holder", label: "Account holder", type: "text" },
  { key: "routing_number", label: "Routing number", type: "text", sensitive: true },
  { key: "account_number", label: "Account number", type: "text", sensitive: true },
];

export type BankAccountValues = Record<string, string>;

export async function getBankAccount(sb: SupabaseClient): Promise<BankAccountValues> {
  const { data, error } = await sb.from("tax_bank_account").select("*").eq("id", true).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return {};

  const row = data as Record<string, unknown>;
  const values: BankAccountValues = {};
  for (const field of BANK_ACCOUNT_SCHEMA) {
    const value = row[field.key];
    if (value != null) values[field.key] = String(value);
  }
  return values;
}

export async function putBankAccount(sb: SupabaseClient, values: BankAccountValues): Promise<void> {
  const existing = await getBankAccount(sb);
  const merged: BankAccountValues = { ...existing };
  for (const [key, value] of Object.entries(values)) {
    // Blank = "leave unchanged" so a masked routing/account number round-trip can't wipe it.
    if (value !== "" && value != null) merged[key] = value;
  }

  const { error } = await sb
    .from("tax_bank_account")
    .upsert({ id: true, ...merged }, { onConflict: "id" });
  if (error) throw new Error(error.message);
}

/** Human-readable label for a stored `account_type` value, for read-only display. */
export function bankAccountTypeLabel(accountType: string | undefined): string {
  return BANK_ACCOUNT_TYPES.find((t) => t.value === accountType)?.label ?? "—";
}
