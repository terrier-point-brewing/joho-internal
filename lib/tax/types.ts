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
  required?: boolean;
  help?: string;
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
  computeWorksheet(ctx: ComputeContext): Promise<WorksheetData>;
  fieldOwnership: Record<string, FieldOwnership>;
  mergeWorksheet(current: WorksheetData, recomputed: WorksheetData): WorksheetData;
  settingsSchema: FieldSpec[];         // profile-level editable fields
  scheduleConfigSchema: FieldSpec[];   // schedule.config editable fields (counties)
  referenceView: ReferenceSpec;
  recomputeLabel?: string;
  worksheetComponent: string;          // registry key for the React worksheet
}
