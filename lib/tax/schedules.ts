/**
 * Thin CRUD wrappers over `tax_schedules` — the recurring filing cadence per
 * party (frequency, lead_days, active flag, party-specific config). Takes an
 * injected `SupabaseClient` (same convention as lib/tax/tasks.ts and
 * lib/tax/backfillLineItemTaxes.ts) so this is testable with a stub.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Frequency, TaxSchedule } from "./types";

export interface ListSchedulesFilter {
  partyKey?: string;
  activeOnly?: boolean;
}

export async function getSchedule(sb: SupabaseClient, id: string): Promise<TaxSchedule | null> {
  const { data, error } = await sb.from("tax_schedules").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as TaxSchedule | null) ?? null;
}

export async function listSchedules(sb: SupabaseClient, filter: ListSchedulesFilter = {}): Promise<TaxSchedule[]> {
  let query = sb.from("tax_schedules").select("*").order("created_at", { ascending: true });
  if (filter.partyKey) query = query.eq("filing_key", filter.partyKey);
  if (filter.activeOnly) query = query.eq("active", true);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as TaxSchedule[];
}

export interface CreateScheduleInput {
  filing_key: string;
  frequency: Frequency;
  lead_days?: number;
  active?: boolean;
  config?: Record<string, unknown>;
}

export async function createSchedule(sb: SupabaseClient, input: CreateScheduleInput): Promise<TaxSchedule> {
  const { data, error } = await sb
    .from("tax_schedules")
    .insert({
      filing_key: input.filing_key,
      frequency: input.frequency,
      lead_days: input.lead_days ?? 7,
      active: input.active ?? true,
      config: input.config ?? {},
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as TaxSchedule;
}

export type UpdateScheduleInput = Partial<Pick<TaxSchedule, "frequency" | "lead_days" | "active" | "config">>;

export async function updateSchedule(sb: SupabaseClient, id: string, patch: UpdateScheduleInput): Promise<TaxSchedule> {
  const { data, error } = await sb
    .from("tax_schedules")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as TaxSchedule;
}

export async function setScheduleActive(sb: SupabaseClient, id: string, active: boolean): Promise<TaxSchedule> {
  return updateSchedule(sb, id, { active });
}

/** Distinct `filing_key` values across every currently-active schedule — thin wrapper over `listSchedules`, not a new query. */
export async function listActivePartyKeys(sb: SupabaseClient): Promise<string[]> {
  const schedules = await listSchedules(sb, { activeOnly: true });
  return [...new Set(schedules.map((s) => s.filing_key))];
}
