import type { SupabaseClient } from "@supabase/supabase-js";
import { addDaysStr, todayLocalDate } from "@/lib/utils/datetime";

export type InvoiceKind = "deposit" | "export";

const SETTINGS_KEY: Record<InvoiceKind, string> = {
  deposit: "deposit_invoice_due_days",
  export: "export_invoice_due_days",
};

/** Fallback when the setting row is missing or unreadable. */
export const DEFAULT_NET_TERMS_DAYS = 30;
/** 0 = due on receipt; Square accepts a due date equal to the invoice date. */
export const MIN_NET_TERMS_DAYS = 0;
export const MAX_NET_TERMS_DAYS = 365;

export function isValidNetTermsDays(days: unknown): days is number {
  return Number.isInteger(days) && (days as number) >= MIN_NET_TERMS_DAYS && (days as number) <= MAX_NET_TERMS_DAYS;
}

/** Operator-facing label for a terms value: "Due on receipt" / "Net 14". */
export function netTermsLabel(days: number): string {
  return days <= 0 ? "Due on receipt" : `Net ${days}`;
}

/**
 * The single configured net-terms value (in days) for the given invoice type,
 * read from system_settings. There is no per-partner override — this is the one
 * source of truth. Falls back to 30 when the row is missing, the read errors,
 * or the stored value is not a valid day count.
 */
export async function getNetTermsDays(
  supabase: SupabaseClient,
  kind: InvoiceKind,
): Promise<number> {
  const key = SETTINGS_KEY[kind];
  const { data, error } = await supabase
    .from("system_settings")
    .select("value")
    .eq("key", key)
    .single();
  if (error) {
    console.error(`[invoiceTerms] failed to read ${key}:`, error);
    return DEFAULT_NET_TERMS_DAYS;
  }
  const value = data?.value as unknown;
  return isValidNetTermsDays(value) ? value : DEFAULT_NET_TERMS_DAYS;
}

export interface InvoiceDraftDates {
  netTermsDays: number;
  /** The day the draft is raised (brewery-local). Doubles as the service date. */
  draftDate: string;
  /** draftDate + net terms. Equal to draftDate when terms are "due on receipt". */
  dueDate: string;
}

/**
 * The one way an invoice's dates are derived: every path that raises or
 * re-raises a Square draft (deposit, export, line-item edit) calls this, so
 * invoice_date, sale_or_service_date and due_date can never disagree.
 */
export async function invoiceDraftDates(
  supabase: SupabaseClient,
  kind: InvoiceKind,
  now: Date = new Date(),
): Promise<InvoiceDraftDates> {
  const netTermsDays = await getNetTermsDays(supabase, kind);
  const draftDate = todayLocalDate(undefined, now);
  return { netTermsDays, draftDate, dueDate: addDaysStr(draftDate, netTermsDays) };
}
