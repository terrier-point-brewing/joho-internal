export type JobTitle = "Bartender" | "Brewer" | "Taproom Manager";
export type EmploymentType =
  | "salary_no_overtime"
  | "salary_overtime_eligible"
  | "hourly";
export type TipDistributionModel = "proportional_hours";
export type TipPoolFrequency = "daily" | "weekly" | "biweekly";
export type PayPeriodStatus = "open" | "locked";

export interface PayrollConfig {
  id: string;
  effective_from: string;
  base_rate_cents: number;
  guaranteed_rate_cents: number;
  reported_cash_tips_divisor: number;
  tip_distribution_model: TipDistributionModel;
  tip_pool_frequency: TipPoolFrequency;
  guaranteed_min_frequency: TipPoolFrequency;
  pay_period_frequency: 'weekly' | 'biweekly';
  due_date_days_after_end: number;
  created_at: string;
}

export interface Employee {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone_number: string | null;
  job_title: JobTitle;
  employment_type: EmploymentType;
  receives_tips: boolean;
  square_team_member_id: string | null;
  gusto_employee_id: string | null;
  active: boolean;
  created_at: string;
}

export interface PayPeriod {
  id: string;
  start_date: string;
  end_date: string;
  due_date: string | null;
  status: PayPeriodStatus;
  locked_at: string | null;
  locked_by: string | null;
  created_at: string;
}

export interface PayrollEntry {
  id: string;
  pay_period_id: string;
  employee_id: string;
  hours_worked: number | null;
  paycheck_tips_cents: number | null;
  cash_tips_cents: number | null;
  reported_cash_tips_cents: number | null;
  bonus_cents: number | null;
  adj_hours_worked: number | null;
  adj_paycheck_tips_cents: number | null;
  adj_cash_tips_cents: number | null;
  adj_reported_cash_tips_cents: number | null;
  adj_bonus_cents: number | null;
  admin_notes: string | null;
  created_at: string;
  updated_at: string;
}

/** Values computed fresh from Square data each preview request. */
export interface PayrollEntryComputed {
  employee_id: string;
  hours_worked: number;
  paycheck_tips_cents: number;
  cash_tips_cents: number;
  reported_cash_tips_cents: number;
  bonus_cents: number;
  base_pay_cents: number;
  total_compensation_cents: number;
}

/** Computed values merged with any admin adjustments. Effective_* are final. */
export interface PayrollEntryMerged extends PayrollEntryComputed {
  adj_hours_worked: number | null;
  adj_paycheck_tips_cents: number | null;
  adj_cash_tips_cents: number | null;
  adj_reported_cash_tips_cents: number | null;
  adj_bonus_cents: number | null;
  admin_notes: string | null;
  effective_hours: number;
  effective_paycheck_tips_cents: number;
  effective_cash_tips_cents: number;
  effective_reported_cash_tips_cents: number;
  effective_bonus_cents: number;
  effective_total_compensation_cents: number;
}

// ── Gusto GL-split upload (payroll_gl_reports / _employees / _totals) ──────

export interface PayrollGlReport {
  id: string;
  pay_period_id: string;
  storage_path: string;
  original_filename: string;
  uploaded_at: string;
  uploaded_by: string;
  superseded_at: string | null;
}

export interface PayrollGlReportEmployee {
  id: string;
  report_id: string;
  last_name: string;
  first_name: string;
  department: string;
  job: string | null;
  pay_type: string | null;
  gross_amount_cents: number;
  employer_tax_cents: number;
}

export interface PayrollGlReportTotal {
  id: string;
  report_id: string;
  chart_of_accounts_id: string;
  amount_cents: number;
}

export interface TipBucketSummary {
  label: string;
  tipsPooledCents: number;
}

/** Full preview response from /api/payroll/periods/[id]/preview */
export interface PayrollPreview {
  period: PayPeriod;
  config: PayrollConfig;
  entries: PayrollEntryMerged[];
  /** Hourly tip-eligible employees that correspond to `entries`, by index/id. */
  employees: Employee[];
  salaried_employees: Employee[];
  total_pooled_tips_cents: number;
  /** Per-bucket tip totals (1 for biweekly, 2 for weekly, N for daily). */
  tip_buckets: TipBucketSummary[];
}
