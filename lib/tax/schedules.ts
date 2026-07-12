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

export async function listSchedules(sb: SupabaseClient, filter: ListSchedulesFilter = {}): Promise<TaxSchedule[]> {
  let query = sb.from("tax_schedules").select("*").order("created_at", { ascending: true });
  if (filter.partyKey) query = query.eq("party_key", filter.partyKey);
  if (filter.activeOnly) query = query.eq("active", true);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as TaxSchedule[];
}

export interface CreateScheduleInput {
  party_key: string;
  frequency: Frequency;
  lead_days?: number;
  active?: boolean;
  config?: Record<string, unknown>;
}

export async function createSchedule(sb: SupabaseClient, input: CreateScheduleInput): Promise<TaxSchedule> {
  const { data, error } = await sb
    .from("tax_schedules")
    .insert({
      party_key: input.party_key,
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
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as TaxSchedule;
}

export async function setScheduleActive(sb: SupabaseClient, id: string, active: boolean): Promise<TaxSchedule> {
  return updateSchedule(sb, id, { active });
}
