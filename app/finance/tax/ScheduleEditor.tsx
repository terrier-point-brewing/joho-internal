"use client";

import { useState, type FormEvent } from "react";
import { Modal, Field, ModalActions } from "@/app/components/ui/Modal";
import Banner from "@/app/components/ui/Banner";
import type { FieldSpec, Frequency, TaxSchedule } from "@/lib/tax/types";
import {
  readMultiSelect,
  validateCountyWeights,
  validateMultiSelect,
  type CountyWeight,
} from "@/lib/tax/scheduleConfig";
import { isFixedDueRule, readDueRule, resolveDueDate, validateDueRule, type DueRule } from "@/lib/tax/dueDate";
import { addDaysIso } from "@/lib/tax/period";
import type { TaxPartyMeta } from "./hooks/useTaxData";

interface ScheduleEditorProps {
  /** `null` creates a new schedule; a `TaxSchedule` edits that row (party is then locked — the API doesn't allow re-parenting a schedule). */
  schedule: TaxSchedule | null;
  parties: TaxPartyMeta[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

const MONTH_LABEL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const FREQUENCY_LABEL: Record<Frequency, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  annual: "Annual",
};

function countiesFromConfig(config: Record<string, unknown> | undefined): CountyWeight[] {
  const raw = config?.counties;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is { code: unknown; weight: unknown } => typeof c === "object" && c !== null)
    .map((c) => ({ code: String(c.code), weight: Number(c.weight) || 0 }));
}

/**
 * Seeds every `"multiselect"` field in the party's `scheduleConfigSchema` from
 * the schedule's stored config, dropping any value the field no longer offers.
 */
function multiSelectsFromConfig(
  schema: FieldSpec[],
  config: Record<string, unknown> | undefined,
): Record<string, string[]> {
  const state: Record<string, string[]> = {};
  for (const field of schema) {
    if (field.type !== "multiselect") continue;
    state[field.key] = readMultiSelect(config, field.key, (field.options ?? []).map((o) => o.value));
  }
  return state;
}

function seedRule(sched: TaxSchedule | null, party: TaxPartyMeta | undefined, freq: Frequency): DueRule {
  return readDueRule(sched?.config) ?? party?.defaultDueRules?.[freq] ?? { monthOffset: 1, day: "last" };
}

export default function ScheduleEditor({ schedule, parties, onClose, onSaved }: ScheduleEditorProps) {
  const [partyKey, setPartyKey] = useState(schedule?.filing_key ?? parties[0]?.key ?? "");
  const selectedParty = parties.find((p) => p.key === partyKey);

  const [frequency, setFrequency] = useState<Frequency>(
    schedule?.frequency ?? (selectedParty?.supportedFrequencies[0] as Frequency) ?? "monthly",
  );
  const [leadDays, setLeadDays] = useState(String(schedule?.lead_days ?? 7));
  const [active, setActive] = useState(schedule?.active ?? true);
  const [counties, setCounties] = useState<CountyWeight[]>(countiesFromConfig(schedule?.config));
  const [multiSelects, setMultiSelects] = useState<Record<string, string[]>>(() =>
    multiSelectsFromConfig(selectedParty?.scheduleConfigSchema ?? [], schedule?.config),
  );
  const [dueRule, setDueRule] = useState<DueRule>(() => seedRule(schedule, selectedParty, frequency));
  const [dueRuleTouched, setDueRuleTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scheduleConfigSchema: FieldSpec[] = selectedParty?.scheduleConfigSchema ?? [];
  const countiesField = scheduleConfigSchema.find((f) => f.key === "counties");
  const countyError = countiesField ? validateCountyWeights(counties) : null;

  const multiSelectFields = scheduleConfigSchema.filter((f) => f.type === "multiselect");
  const multiSelectError =
    multiSelectFields
      .map((f) => validateMultiSelect(f.label, f.required, multiSelects[f.key] ?? []))
      .find((msg) => msg !== null) ?? null;

  // Preview against the party's OWN current period (served by
  // GET /api/tax/parties), so a party with a non-calendar period — Wake
  // County's May 1 – April 30 license year — isn't previewed against a period
  // it never produces.
  const sampleEnd = selectedParty?.samplePeriods?.[frequency]?.end;
  const dueRuleError = validateDueRule(dueRule);
  const dueDatePreview = dueRuleError
    ? dueRuleError
    : sampleEnd
      ? (() => {
          const due = resolveDueDate(sampleEnd, dueRule);
          return `The period ending ${sampleEnd} is due ${due}, alerting from ${addDaysIso(due, -(Number(leadDays) || 0))}.`;
        })()
      : "Select a party to preview the due date.";

  // Re-seed the due rule whenever party/frequency change (until the user
  // edits it directly) — adjusted during render rather than in an effect, per
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [seededFor, setSeededFor] = useState(`${partyKey}:${frequency}`);
  const seedKey = `${partyKey}:${frequency}`;
  if (seedKey !== seededFor) {
    setSeededFor(seedKey);
    if (!dueRuleTouched) setDueRule(seedRule(schedule, selectedParty, frequency));
  }

  function handlePartyChange(key: string) {
    setPartyKey(key);
    const party = parties.find((p) => p.key === key);
    if (party && !party.supportedFrequencies.includes(frequency)) {
      setFrequency(party.supportedFrequencies[0] as Frequency);
    }
    // A different party has an unrelated county set (or none) — start fresh
    // rather than carrying over weights that no longer correspond to options.
    setCounties([]);
    // Same reasoning for multiselects: another party's options don't apply.
    setMultiSelects(multiSelectsFromConfig(party?.scheduleConfigSchema ?? [], schedule?.config));
    setDueRuleTouched(false);
  }

  function toggleMultiSelect(fieldKey: string, value: string, checked: boolean) {
    setMultiSelects((cur) => {
      const current = cur[fieldKey] ?? [];
      return {
        ...cur,
        [fieldKey]: checked ? [...current, value] : current.filter((v) => v !== value),
      };
    });
  }

  function toggleCounty(code: string, checked: boolean) {
    setCounties((cur) => (checked ? [...cur, { code, weight: 0 }] : cur.filter((c) => c.code !== code)));
  }

  function setCountyWeight(code: string, weight: number) {
    setCounties((cur) => cur.map((c) => (c.code === code ? { ...c, weight } : c)));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (countyError || multiSelectError) return;

    setSubmitting(true);
    setError(null);
    try {
      const config: Record<string, unknown> = { ...(schedule?.config ?? {}) };
      if (countiesField) config.counties = counties;
      for (const field of multiSelectFields) config[field.key] = multiSelects[field.key] ?? [];
      config.dueRule = dueRule;

      const body = schedule
        ? { frequency, lead_days: Number(leadDays) || 0, config, active }
        : { filing_key: partyKey, frequency, lead_days: Number(leadDays) || 0, config };

      const res = schedule
        ? await fetch(`/api/tax/schedules/${schedule.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        : await fetch("/api/tax/schedules", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });

      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to save schedule.");
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={schedule ? "Edit Schedule" : "New Schedule"} wide onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-5">
        {error && <Banner tone="danger">{error}</Banner>}

        <Field label="Party" required>
          <select
            className="inp"
            value={partyKey}
            required
            disabled={!!schedule}
            onChange={(e) => handlePartyChange(e.target.value)}
          >
            {parties.length === 0 && <option value="">— no parties registered —</option>}
            {parties.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-faint mt-1">
            {schedule ? "The party can't change after a schedule is created. " : ""}
            Filing identity (FEIN, contact, account ID) is configured under Settings → Tax Filing, not here.
          </p>
        </Field>

        <div className="grid grid-cols-2 gap-3 items-start">
          <Field label="Frequency" required>
            <select className="inp" value={frequency} required onChange={(e) => setFrequency(e.target.value as Frequency)}>
              {(selectedParty?.supportedFrequencies ?? []).map((f) => (
                <option key={f} value={f}>
                  {FREQUENCY_LABEL[f as Frequency] ?? f}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Lead days">
            <input
              type="number"
              min="0"
              className="inp"
              value={leadDays}
              onChange={(e) => setLeadDays(e.target.value)}
            />
            <p className="text-xs text-faint mt-1">Days before the due date to open the task.</p>
          </Field>
        </div>

        <Field label="Due date" hint="When the filing is due — either relative to each period's end, or a fixed calendar date.">
          <div className="flex flex-wrap items-center gap-2 text-sm text-body mb-2">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                checked={!isFixedDueRule(dueRule)}
                onChange={() => {
                  setDueRuleTouched(true);
                  setDueRule((r) => ({ monthOffset: 1, day: r.day }));
                }}
              />
              Relative to period end
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                checked={isFixedDueRule(dueRule)}
                onChange={() => {
                  setDueRuleTouched(true);
                  setDueRule((r) => ({ fixedMonth: 4, day: r.day }));
                }}
              />
              Fixed calendar date
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-body">
            {isFixedDueRule(dueRule) ? (
              <>
                <span className="text-muted">Every</span>
                <select
                  className="inp w-36"
                  value={dueRule.fixedMonth}
                  onChange={(e) => {
                    setDueRuleTouched(true);
                    setDueRule((r) => ({ ...r, fixedMonth: Number(e.target.value) || 1 }));
                  }}
                >
                  {MONTH_LABEL.map((label, i) => (
                    <option key={label} value={i + 1}>
                      {label}
                    </option>
                  ))}
                </select>
                <span className="text-muted">on the</span>
              </>
            ) : (
              <>
                <input
                  type="number"
                  min="0"
                  max="12"
                  className="inp w-16"
                  value={dueRule.monthOffset}
                  onChange={(e) => {
                    setDueRuleTouched(true);
                    setDueRule((r) => ({ ...r, monthOffset: Number(e.target.value) || 0 }));
                  }}
                />
                <span className="text-muted">month(s) after period end, on</span>
              </>
            )}
            <input
              type="number"
              min="1"
              max="31"
              className="inp w-16"
              disabled={dueRule.day === "last"}
              value={dueRule.day === "last" ? "" : dueRule.day}
              onChange={(e) => {
                setDueRuleTouched(true);
                setDueRule((r) => ({ ...r, day: Number(e.target.value) || 1 }));
              }}
            />
          </div>
          <label className="flex items-center gap-1.5 text-sm text-body mt-2">
            <input
              type="checkbox"
              checked={dueRule.day === "last"}
              onChange={(e) => {
                setDueRuleTouched(true);
                setDueRule((r) => ({ ...r, day: e.target.checked ? "last" : 20 }));
              }}
            />
            Use the last day of that month instead
          </label>
          <p className="text-xs text-faint mt-1">{dueDatePreview}</p>
          {dueRuleError && <p className="text-xs text-danger mt-1">{dueRuleError}</p>}
        </Field>

        {schedule && (
          <Field label="Status">
            <label className="flex items-center gap-2 text-sm text-body">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
              Active
            </label>
          </Field>
        )}

        {countiesField && (
          <Field label={countiesField.label} required hint={countiesField.help}>
            <div className="border border-line rounded-lg max-h-72 overflow-y-auto divide-y divide-line/60">
              {(countiesField.options ?? []).map((opt) => {
                const county = counties.find((c) => c.code === opt.value);
                const checked = county !== undefined;
                return (
                  <div key={opt.value} className="flex items-center gap-3 px-3 py-1.5">
                    <label className="flex items-center gap-2 text-sm text-body flex-1 min-w-0">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => toggleCounty(opt.value, e.target.checked)}
                      />
                      <span className="truncate">{opt.label}</span>
                    </label>
                    {checked && (
                      <div className="flex items-center gap-1 shrink-0">
                        <input
                          type="number"
                          className="inp w-20"
                          min="0"
                          max="100"
                          step="0.01"
                          value={county.weight}
                          onChange={(e) => setCountyWeight(opt.value, parseFloat(e.target.value) || 0)}
                        />
                        <span className="text-xs text-muted">%</span>
                      </div>
                    )}
                  </div>
                );
              })}
              {(countiesField.options ?? []).length === 0 && (
                <p className="px-3 py-2 text-xs text-faint">No county options available.</p>
              )}
            </div>
            {countyError ? (
              <p className="text-xs text-danger mt-1">{countyError}</p>
            ) : (
              <p className="text-xs text-faint mt-1">
                Total: {counties.reduce((sum, c) => sum + (Number.isFinite(c.weight) ? c.weight : 0), 0).toFixed(2)}%
              </p>
            )}
          </Field>
        )}

        {multiSelectFields.map((field) => {
          const selected = multiSelects[field.key] ?? [];
          // Rendered inside the Field, in place of the "N selected" line — an
          // error belongs beside the control that caused it, not in a banner
          // at the foot of the form.
          const fieldError = validateMultiSelect(field.label, field.required, selected);
          return (
            <Field key={field.key} label={field.label} required={field.required} hint={field.help}>
              <div className="border border-line rounded-lg max-h-72 overflow-y-auto grid grid-cols-2 gap-x-4 gap-y-1 p-2">
                {(field.options ?? []).map((opt) => (
                  <label key={opt.value} className="flex items-center gap-2 text-sm text-body">
                    <input
                      type="checkbox"
                      checked={selected.includes(opt.value)}
                      onChange={(e) => toggleMultiSelect(field.key, opt.value, e.target.checked)}
                    />
                    <span className="truncate">{opt.label}</span>
                  </label>
                ))}
                {(field.options ?? []).length === 0 && (
                  <p className="col-span-2 px-1 py-1 text-xs text-faint">No options available.</p>
                )}
              </div>
              {fieldError ? (
                <p className="text-xs text-danger mt-1">{fieldError}</p>
              ) : (
                <p className="text-xs text-faint mt-1">{selected.length} selected</p>
              )}
            </Field>
          );
        })}


        <ModalActions
          submitting={submitting}
          onCancel={onClose}
          label={schedule ? "Save Changes" : "Create Schedule"}
          disabled={!!countyError || !!multiSelectError || !!dueRuleError || !partyKey}
        />
      </form>
    </Modal>
  );
}
