"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Card from "@/app/components/ui/Card";
import Badge from "@/app/components/ui/Badge";
import Banner from "@/app/components/ui/Banner";
import ConfirmDialog from "@/app/components/ui/ConfirmDialog";
import { queryKeys } from "@/lib/query-keys";
import type { Frequency, TaxSchedule } from "@/lib/tax/types";
import type { TaxPartyMeta } from "./hooks/useTaxData";
import ScheduleEditor from "./ScheduleEditor";

interface ScheduleListProps {
  schedules: TaxSchedule[];
  parties: TaxPartyMeta[];
}

const FREQUENCY_LABEL: Record<Frequency, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  annual: "Annual",
};

/** Short human summary of `schedule.config.counties` for the list row, e.g. "3 counties". */
function countySummary(schedule: TaxSchedule): string | null {
  const counties = schedule.config?.counties;
  if (!Array.isArray(counties) || counties.length === 0) return null;
  if (counties.length === 1) {
    const only = counties[0] as { code?: string };
    return only.code ?? "1 county";
  }
  return `${counties.length} counties`;
}

/**
 * Schedule list + create/edit/deactivate actions for the Tax tab. Editing
 * state doubles as the "which modal is open" flag: `undefined` = closed,
 * `null` = create, a `TaxSchedule` = edit that row.
 */
export default function ScheduleList({ schedules, parties }: ScheduleListProps) {
  const qc = useQueryClient();
  const [editingSchedule, setEditingSchedule] = useState<TaxSchedule | null | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deactivating, setDeactivating] = useState<TaxSchedule | null>(null);
  const [error, setError] = useState<string | null>(null);

  const partyLabel = new Map(parties.map((p) => [p.key, p.label]));

  async function refresh() {
    await qc.invalidateQueries({ queryKey: queryKeys.tax.schedules() });
  }

  async function runDeactivate(schedule: TaxSchedule) {
    setBusyId(schedule.id);
    setError(null);
    try {
      const res = await fetch(`/api/tax/schedules/${schedule.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to deactivate schedule.");
      await refresh();
      setDeactivating(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-faint">Schedules</h3>
        <button className="btn-primary" onClick={() => setEditingSchedule(null)}>
          + New Schedule
        </button>
      </div>

      {schedules.length === 0 ? (
        <Card className="text-center py-6">
          <p className="text-sm text-secondary">No filing schedules yet.</p>
          <p className="text-xs text-faint mt-1">Add one to start generating tax tasks.</p>
        </Card>
      ) : (
        <Card padding="">
          <ul className="divide-y divide-line/60">
            {schedules.map((schedule) => (
              <li key={schedule.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm text-strong truncate">
                    {partyLabel.get(schedule.party_key) ?? schedule.party_key}
                  </p>
                  <p className="text-xs text-faint">
                    {FREQUENCY_LABEL[schedule.frequency] ?? schedule.frequency} · {schedule.lead_days}d lead
                    {countySummary(schedule) ? ` · ${countySummary(schedule)}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <Badge tone={schedule.active ? "success" : "neutral"}>
                    {schedule.active ? "Active" : "Inactive"}
                  </Badge>
                  <button
                    className="btn-secondary btn-xxs"
                    onClick={() => setEditingSchedule(schedule)}
                  >
                    Edit
                  </button>
                  {schedule.active && (
                    <button
                      className="btn-danger btn-xxs"
                      disabled={busyId === schedule.id}
                      onClick={() => setDeactivating(schedule)}
                    >
                      Deactivate
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {error && <Banner className="mt-2">{error}</Banner>}

      {deactivating && (
        <ConfirmDialog
          title="Deactivate schedule?"
          message={`Deactivate the ${partyLabel.get(deactivating.party_key) ?? deactivating.party_key} ${deactivating.frequency} schedule? Existing tasks are unaffected.`}
          confirmLabel="Deactivate"
          tone="danger"
          busy={busyId === deactivating.id}
          onConfirm={() => runDeactivate(deactivating)}
          onCancel={() => setDeactivating(null)}
        />
      )}

      {editingSchedule !== undefined && (
        <ScheduleEditor
          schedule={editingSchedule}
          parties={parties}
          onClose={() => setEditingSchedule(undefined)}
          onSaved={async () => {
            await refresh();
            setEditingSchedule(undefined);
          }}
        />
      )}
    </section>
  );
}
