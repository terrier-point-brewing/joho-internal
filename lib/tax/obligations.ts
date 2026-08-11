/**
 * Reads and writes over `public.tax_obligations` — the lookup table every
 * `filing_key` points at (see
 * supabase/migrations/20261003090001_tax_obligations_lookup.sql).
 *
 * Only `filing_url` is mutable from the app. `key`, `authority_key` and
 * `label` are declared by a migration alongside the `TaxPartyTemplate` that
 * gives the obligation its behaviour — see lib/tax/obligations.test.ts for why
 * a row without a template is a runtime error, and never something a UI should
 * be able to create.
 *
 * Takes an injected `SupabaseClient` (same convention as schedules.ts /
 * profiles.ts) so this is testable with a stub.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface TaxObligation {
  key: string;
  authority_key: string;
  label: string;
  display_order: number;
  filing_url: string | null;
}

export async function listObligations(sb: SupabaseClient): Promise<TaxObligation[]> {
  const { data, error } = await sb
    .from("tax_obligations")
    .select("key, authority_key, label, display_order, filing_url")
    .order("display_order", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as TaxObligation[];
}

/** `filing_key` -> `filing_url`, for callers that only need the portal link (the parties route, the UI). */
export async function buildFilingUrlMap(sb: SupabaseClient): Promise<Record<string, string | null>> {
  const obligations = await listObligations(sb);
  return Object.fromEntries(obligations.map((o) => [o.key, o.filing_url]));
}

/**
 * Sets (or clears, with `null`) the portal link for one obligation. Does NOT
 * upsert: an obligation row is created by migration beside its template, so a
 * PATCH against an unknown key is a bug, not a create.
 */
export async function setFilingUrl(
  sb: SupabaseClient,
  key: string,
  filingUrl: string | null,
): Promise<TaxObligation> {
  const { data, error } = await sb
    .from("tax_obligations")
    .update({ filing_url: filingUrl })
    .eq("key", key)
    .select("key, authority_key, label, display_order, filing_url")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`Unknown filing obligation "${key}"`);
  return data as TaxObligation;
}

/**
 * Validates a portal link. Empty/absent is valid — the column is nullable
 * because some obligations are filed on paper. Mirrors the DB's scheme CHECK
 * so the editor and the API reject exactly what the constraint would, rather
 * than surfacing a raw Postgres constraint violation to the filer.
 */
export function validateFilingUrl(url: string | null | undefined): string | null {
  if (url === null || url === undefined || url.trim() === "") return null;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return "Filing link must start with http:// or https://.";
  if (/\s/.test(trimmed)) return "Filing link must not contain spaces.";
  try {
    new URL(trimmed);
  } catch {
    return "Filing link is not a valid URL.";
  }
  return null;
}
