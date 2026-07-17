"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import type { FieldSpec, Frequency, ReferenceSpec, TaxSchedule, TaxTask } from "@/lib/tax/types";
import type { TaxRegistration, ResolvedRequiredRegistration } from "@/lib/tax/registrations";
import type { DueRule } from "@/lib/tax/dueDate";

/**
 * Serialized shape of `GET /api/tax/parties` — registry metadata only, no
 * filing data. Mirrors the field set built in app/api/tax/parties/route.ts
 * (`settingsSchema`/`scheduleConfigSchema` are needed by the schedule editor
 * to render party-specific config fields, e.g. NC DOR's county weights;
 * `requiredRegistrations` is already fully resolved server-side — base +
 * this party's own requirements, matched against live tax_registrations).
 */
export interface TaxPartyMeta {
  key: string;
  label: string;
  supportedFrequencies: string[];
  settingsSchema: FieldSpec[];
  scheduleConfigSchema: FieldSpec[];
  requiredRegistrations: ResolvedRequiredRegistration[];
  referenceView: ReferenceSpec;
  recomputeLabel?: string;
  worksheetComponent: string;
  defaultDueRules: Partial<Record<Frequency, DueRule>>;
}

/** Serialized shape of `GET /api/tax/registrations`. */
export interface RegistrationsResponse {
  registrations: TaxRegistration[];
  required: ResolvedRequiredRegistration[];
}

export function useTaxTasksQuery() {
  return useQuery({
    queryKey: queryKeys.tax.tasks(),
    queryFn: () => fetchJson<TaxTask[]>("/api/tax/tasks"),
  });
}

export function useTaxSchedulesQuery() {
  return useQuery({
    queryKey: queryKeys.tax.schedules(),
    queryFn: () => fetchJson<TaxSchedule[]>("/api/tax/schedules"),
  });
}

export function useTaxPartiesQuery() {
  return useQuery({
    queryKey: queryKeys.tax.parties(),
    queryFn: () => fetchJson<TaxPartyMeta[]>("/api/tax/parties"),
  });
}

export function useEntityProfileQuery() {
  return useQuery({
    queryKey: queryKeys.tax.entityProfile(),
    queryFn: () => fetchJson<Record<string, string>>("/api/tax/entity-profile"),
  });
}

export function useLegalRepresentativeQuery() {
  return useQuery({
    queryKey: queryKeys.tax.legalRepresentative(),
    queryFn: () => fetchJson<Record<string, string>>("/api/tax/legal-representative"),
  });
}

export function useBankAccountQuery() {
  return useQuery({
    queryKey: queryKeys.tax.bankAccount(),
    queryFn: () => fetchJson<Record<string, string>>("/api/tax/bank-account"),
  });
}

/**
 * Aggregates the three read-only tax queries the landing page needs. Kept as
 * one hook so `TaskList` gets a single loading/error surface instead of
 * juggling three independent query states.
 */
export function useTaxData() {
  const tasksQuery = useTaxTasksQuery();
  const schedulesQuery = useTaxSchedulesQuery();
  const partiesQuery = useTaxPartiesQuery();

  return {
    tasks: tasksQuery.data ?? [],
    schedules: schedulesQuery.data ?? [],
    parties: partiesQuery.data ?? [],
    isLoading: tasksQuery.isLoading || schedulesQuery.isLoading || partiesQuery.isLoading,
    isError: tasksQuery.isError || schedulesQuery.isError || partiesQuery.isError,
    error: tasksQuery.error ?? schedulesQuery.error ?? partiesQuery.error ?? null,
  };
}
