import type { DueRule } from "./dueDate";
import type { RequiredRegistration } from "./registrations";

export type Frequency = "monthly" | "quarterly" | "annual";
export type TaxTaskStatus = "open" | "completed" | "skipped";
export type FieldOwnership = "computed" | "manual";

export interface TaxPeriod { start: string; end: string; due: string } // YYYY-MM-DD

export interface FieldSpec {
  key: string;
  label: string;
  type: "text" | "number" | "email" | "tel" | "money" | "select";
  sensitive?: boolean;               // SSN/FEIN — never returned to the browser
  options?: { value: string; label: string }[];
  /**
   * Marks a field whose stored value is a Square catalog tax id. Two consumers
   * depend on knowing this, and neither can infer it safely from `type`/
   * `options` alone: the settings form populates the select from Square's live
   * catalog taxes, and `lib/tax/squareTaxUsage.ts` counts which Square taxes an
   * active filing depends on so Finance → GL Mapping can warn before one is
   * excluded out from under a return.
   */
  source?: "square_tax";
  required?: boolean;
  help?: string;
  /**
   * Places this field in a named group of the worksheet's Filing Identity
   * header instead of the catch-all "Filing Settings" group. Only
   * `"registrations"` exists today: a field that is really a filing
   * credential (e.g. Wake County's PIN) belongs beside the account/permit
   * numbers it is used with, not in a settings bucket. A `sensitive` field
   * placed here renders masked with the same on-demand Unmask control the
   * bank numbers use — never the stored value inline.
   */
  identityGroup?: "registrations";
  /**
   * Sort position within `identityGroup` (see `RequiredRegistration.identityOrder`).
   * Unset sorts after everything that sets it, in declaration order.
   */
  identityOrder?: number;
}
export interface ReferenceTable { title: string; columns: string[]; rows: (string | number)[][] }
export interface ReferenceSpec { tables: ReferenceTable[]; notes?: string[] }

/** A worksheet field map: field key -> value (integer cents, text, or null). */
export type WorksheetFields = Record<string, number | string | null>;

// Persisted to tax_tasks.worksheet (jsonb).
export interface WorksheetData {
  fields: WorksheetFields;                           // field key -> value
  warnings?: string[];                               // e.g. reconciliation flag
  meta?: Record<string, unknown>;                    // { computedAt, provenance }
}

export interface TaxSchedule {
  id: string; party_key: string; frequency: Frequency;
  lead_days: number; active: boolean; config: Record<string, unknown>;
  created_at: string; updated_at: string;
}
export interface TaxTask {
  id: string; schedule_id: string; party_key: string;
  period_start: string; period_end: string; due_date: string;
  status: TaxTaskStatus; alert_sent_at: string | null;
  worksheet: WorksheetData | null;
  confirmation_number: string | null; amount_paid_cents: number | null;
  submitted_on: string | null; notes: string | null;
  completed_at: string | null; completed_by: string | null;
  created_at: string; updated_at: string;
}
export interface TaxTaskFile {
  id: string; task_id: string; storage_path: string; file_name: string;
  label: string | null; uploaded_at: string; uploaded_by: string | null;
}

export type TaxFilingProfileValues = Record<string, string>;

export interface ComputeContext {
  schedule: TaxSchedule;
  profile: TaxFilingProfileValues;
  period: TaxPeriod;
}
export interface TaxPartyTemplate {
  key: string;
  label: string;
  supportedFrequencies: Frequency[];
  computePeriod(freq: Frequency, ref: Date): TaxPeriod;
  defaultDueRule(freq: Frequency): DueRule;
  computeWorksheet(ctx: ComputeContext): Promise<WorksheetData>;
  fieldOwnership: Record<string, FieldOwnership>;
  mergeWorksheet(current: WorksheetData, recomputed: WorksheetData, rateMap: Record<string, number>): WorksheetData;
  settingsSchema: FieldSpec[];         // profile-level editable fields
  scheduleConfigSchema: FieldSpec[];   // schedule.config editable fields (counties)
  /** Builds the read-only rate/reference tables from the canonical rateMap (`buildRateMap(await listTaxRates(sb))`). */
  buildReferenceView(rateMap: Record<string, number>): ReferenceSpec;
  recomputeLabel?: string;
  worksheetComponent: string;          // registry key for the React worksheet
  /** This party's own required tax_registrations (beyond BASE_REQUIRED_REGISTRATIONS, which every party gets automatically). */
  requiredRegistrations: RequiredRegistration[];
}
