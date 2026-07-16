import { describe, it, expect } from "vitest";
import type { TaxPartyTemplate, TaxSchedule, TaxTask } from "./types";
import { renderTaxAlertEmail } from "./alertEmail";

const sampleParty: TaxPartyTemplate = {
  key: "nc_dor_sales_use",
  label: "NC DOR — Sales & Use Tax",
  supportedFrequencies: ["monthly", "quarterly"],
  computePeriod: () => ({ start: "2026-06-01", end: "2026-06-30", due: "2026-07-20" }),
  defaultDueRule: () => ({ monthOffset: 1, day: 20 }),
  computeWorksheet: async () => ({ fields: {} }),
  fieldOwnership: {},
  mergeWorksheet: (current) => current,
  settingsSchema: [],
  scheduleConfigSchema: [],
  requiredRegistrations: [],
  buildReferenceView: () => ({ tables: [] }),
  worksheetComponent: "NcDorSalesUseWorksheet",
};

const sampleSchedule: TaxSchedule = {
  id: "SCHED_1",
  party_key: "nc_dor_sales_use",
  frequency: "monthly",
  lead_days: 7,
  active: true,
  config: {},
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const sampleTask: TaxTask = {
  id: "TASK_1",
  schedule_id: "SCHED_1",
  party_key: "nc_dor_sales_use",
  period_start: "2026-06-01",
  period_end: "2026-06-30",
  due_date: "2026-07-20",
  status: "open",
  alert_sent_at: null,
  worksheet: null,
  confirmation_number: null,
  amount_paid_cents: null,
  submitted_on: null,
  notes: null,
  completed_at: null,
  completed_by: null,
  created_at: "2026-06-30T00:00:00Z",
  updated_at: "2026-06-30T00:00:00Z",
};

describe("renderTaxAlertEmail", () => {
  it("includes the party label and due date in the subject", () => {
    const { subject } = renderTaxAlertEmail(sampleTask, sampleParty, sampleSchedule);

    expect(subject).toContain(sampleParty.label);
    expect(subject).toContain(sampleTask.due_date);
  });

  it("includes the period, due date, and worksheet link in the html", () => {
    const { html } = renderTaxAlertEmail(sampleTask, sampleParty, sampleSchedule);

    expect(html).toContain(sampleTask.period_start);
    expect(html).toContain(sampleTask.period_end);
    expect(html).toContain(sampleTask.due_date);
    expect(html).toContain(sampleParty.label);
    expect(html).toContain(`/finance/tax/${sampleTask.id}`);
  });
});
