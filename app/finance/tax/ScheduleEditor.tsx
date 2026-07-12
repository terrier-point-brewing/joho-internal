"use client";

import { useState, type FormEvent } from "react";
import { Modal, Field, ModalActions } from "@/app/components/ui/Modal";
import Banner from "@/app/components/ui/Banner";
import type { FieldSpec, Frequency, TaxSchedule } from "@/lib/tax/types";
import { validateCountyWeights, type CountyWeight } from "@/lib/tax/scheduleConfig";
import type { TaxPartyMeta } from "./hooks/useTaxData";

interface ScheduleEditorProps {
  /** `null` creates a new schedule; a `TaxSchedule` edits that row (party is then locked — the API doesn't allow re-parenting a schedule). */
  schedule: TaxSchedule | null;
  parties: TaxPartyMeta[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

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

export default function ScheduleEditor({ schedule, parties, onClose, onSaved }: ScheduleEditorProps) {
  const [partyKey, setPartyKey] = useState(schedule?.party_key ?? parties[0]?.key ?? "");
  const selectedParty = parties.find((p) => p.key === partyKey);

  const [frequency, setFrequency] = useState<Frequency>(
    schedule?.frequency ?? (selectedParty?.supportedFrequencies[0] as Frequency) ?? "monthly",
  );
  const [leadDays, setLeadDays] = useState(String(schedule?.lead_days ?? 7));
  const [active, setActive] = useState(schedule?.active ?? true);
  const [counties, setCounties] = useState<CountyWeight[]>(countiesFromConfig(schedule?.config));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scheduleConfigSchema: FieldSpec[] = selectedParty?.scheduleConfigSchema ?? [];
  const countiesField = scheduleConfigSchema.find((f) => f.key === "counties");
  const countyError = countiesField ? validateCountyWeights(counties) : null;

  function handlePartyChange(key: string) {
    setPartyKey(key);
    const party = parties.find((p) => p.key === key);
    if (party && !party.supportedFrequencies.includes(frequency)) {
      setFrequency(party.supportedFrequencies[0] as Frequency);
    }
    // A different party has an unrelated county set (or none) — start fresh
    // rather than carrying over weights that no longer correspond to options.
    setCounties([]);
  }

  function toggleCounty(code: string, checked: boolean) {
    setCounties((cur) => (checked ? [...cur, { code, weight: 0 }] : cur.filter((c) => c.code !== code)));
  }

  function setCountyWeight(code: string, weight: number) {
    setCounties((cur) => cur.map((c) => (c.code === code ? { ...c, weight } : c)));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (countyError) return;

    setSubmitting(true);
    setError(null);
    try {
      const config: Record<string, unknown> = { ...(schedule?.config ?? {}) };
      if (countiesField) config.counties = counties;

      const body = schedule
        ? { frequency, lead_days: Number(leadDays) || 0, config, active }
        : { party_key: partyKey, frequency, lead_days: Number(leadDays) || 0, config };

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
    <Modal title={schedule ? "Edit Schedule" : "New Schedule"} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
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
          {schedule && <p className="text-xs text-faint mt-1">The party can&apos;t change after a schedule is created.</p>}
          {selectedParty?.settingsSchema && selectedParty.settingsSchema.length > 0 && (
            <p className="text-xs text-faint mt-1">
              Filing identity (FEIN, contact, account ID) is set on the party&apos;s settings, not here.
            </p>
          )}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Frequency" required>
            <select className="inp" value={frequency} required onChange={(e) => setFrequency(e.target.value as Frequency)}>
              {(selectedParty?.supportedFrequencies ?? []).map((f) => (
                <option key={f} value={f}>
                  {FREQUENCY_LABEL[f as Frequency] ?? f}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Lead days" hint="days before due date to open the task">
            <input
              type="number"
              min="0"
              className="inp"
              value={leadDays}
              onChange={(e) => setLeadDays(e.target.value)}
            />
          </Field>
        </div>

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
            <div className="border border-line rounded-lg max-h-56 overflow-y-auto divide-y divide-line/60">
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
                          className="inp-sm w-20"
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
            <p className="text-xs text-faint mt-1">
              Total: {counties.reduce((sum, c) => sum + (Number.isFinite(c.weight) ? c.weight : 0), 0).toFixed(2)}%
            </p>
          </Field>
        )}

        {countyError && <Banner tone="danger">{countyError}</Banner>}

        <ModalActions
          submitting={submitting}
          onCancel={onClose}
          label={schedule ? "Save Changes" : "Create Schedule"}
          disabled={!!countyError || !partyKey}
        />
      </form>
    </Modal>
  );
}
