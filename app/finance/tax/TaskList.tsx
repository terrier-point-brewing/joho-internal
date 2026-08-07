"use client";

import { useMemo } from "react";
import Link from "next/link";
import Card from "@/app/components/ui/Card";
import Badge from "@/app/components/ui/Badge";
import FilterBar from "@/app/components/ui/FilterBar";
import SearchInput from "@/app/components/ui/SearchInput";
import FilterChips from "@/app/components/ui/FilterChips";
import { useTableControls } from "@/app/components/ui/useTableControls";
import type { Tone } from "@/app/components/ui/tone";
import { taskDueStatus, type TaskUrgency } from "@/lib/tax/taskDueStatus";
import { todayLocalDate } from "@/lib/utils/datetime";
import type { ControlsConfig } from "@/lib/table/types";
import type { TaxSchedule, TaxTask } from "@/lib/tax/types";
import type { TaxPartyMeta } from "./hooks/useTaxData";

interface TaskListProps {
  tasks: TaxTask[];
  schedules: TaxSchedule[];
  parties: TaxPartyMeta[];
  /** Which bucket this instance renders — one per subtab, so Open and Closed never share a scroll. */
  status: "open" | "closed";
}

const URGENCY_RANK: Record<TaskUrgency, number> = { overdue: 0, "due-soon": 1, open: 2 };
const URGENCY_TONE: Record<TaskUrgency, Tone> = { overdue: "danger", "due-soon": "info", open: "neutral" };
const URGENCY_LABEL: Record<TaskUrgency, string> = { overdue: "Overdue", "due-soon": "Due soon", open: "Open" };

/** Date-only (YYYY-MM-DD) strings anchored at UTC noon so no host timezone shifts the calendar day. */
function formatIsoDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function TaskList({ tasks, schedules, parties, status }: TaskListProps) {
  const partyLabel = useMemo(() => new Map(parties.map((p) => [p.key, p.label])), [parties]);
  const scheduleById = useMemo(() => new Map(schedules.map((s) => [s.id, s])), [schedules]);

  const controlsConfig = useMemo<ControlsConfig<TaxTask>>(
    () => ({
      search: [{ param: "q", accessor: (t) => [partyLabel.get(t.filing_key), t.notes, t.confirmation_number] }],
      filters: [{ param: "party", accessor: (t) => t.filing_key }],
    }),
    [partyLabel],
  );
  const { rows, search, filters, setSearch, setFilter, reset, activeCount } = useTableControls(tasks, controlsConfig);

  const partyOptions = useMemo(
    () => parties.map((p) => ({ value: p.key, label: p.label })),
    [parties],
  );

  if (tasks.length === 0) {
    return (
      <Card className="text-center py-8">
        <p className="text-sm text-secondary">No tax tasks yet.</p>
        <p className="text-xs text-faint mt-1">Tasks appear here once a filing schedule is set up.</p>
      </Card>
    );
  }

  const today = todayLocalDate();

  const openRows = rows
    .filter((t) => t.status === "open")
    .map((task) => ({ task, urgency: taskDueStatus(task, scheduleById.get(task.schedule_id), today) }))
    .sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || a.task.due_date.localeCompare(b.task.due_date));

  const doneRows = rows
    .filter((t) => t.status !== "open")
    .sort((a, b) => b.due_date.localeCompare(a.due_date));

  return (
    <div className="flex flex-col gap-6">
      <FilterBar activeCount={activeCount} onClear={reset}>
        <SearchInput value={search.q ?? ""} onChange={(v) => setSearch("q", v)} placeholder="Search tax tasks…" />
        {partyOptions.length > 1 && (
          <FilterChips
            label="Party"
            options={partyOptions}
            value={filters.party ?? []}
            onChange={(v) => setFilter("party", v)}
          />
        )}
      </FilterBar>

      {status === "open" ? (
        openRows.length === 0 ? (
          <p className="text-sm text-faint px-1">
            {activeCount > 0 ? "No open tasks match your filters." : "Nothing open — all caught up."}
          </p>
        ) : (
          <Card padding="">
            <ul className="divide-y divide-line/60">
              {openRows.map(({ task, urgency }) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  label={partyLabel.get(task.filing_key) ?? task.filing_key}
                  tone={URGENCY_TONE[urgency]}
                  statusLabel={URGENCY_LABEL[urgency]}
                />
              ))}
            </ul>
          </Card>
        )
      ) : doneRows.length === 0 ? (
        <p className="text-sm text-faint px-1">
          {activeCount > 0 ? "No closed tasks match your filters." : "Nothing closed yet."}
        </p>
      ) : (
        <Card padding="">
          <ul className="divide-y divide-line/60">
            {doneRows.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                label={partyLabel.get(task.filing_key) ?? task.filing_key}
                tone={task.status === "completed" ? "success" : "neutral"}
                statusLabel={task.status === "completed" ? "Completed" : "Skipped"}
              />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function TaskRow({
  task,
  label,
  tone,
  statusLabel,
}: {
  task: TaxTask;
  label: string;
  tone: Tone;
  statusLabel: string;
}) {
  return (
    <li>
      <Link
        href={`/finance/tax/${task.id}`}
        className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-surface-mid/30"
      >
        <div className="min-w-0">
          <p className="text-sm text-strong truncate">{label}</p>
          <p className="text-xs text-faint">Period ending {formatIsoDate(task.period_end)}</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-xs text-secondary tabular-nums">Due {formatIsoDate(task.due_date)}</span>
          <Badge tone={tone}>{statusLabel}</Badge>
        </div>
      </Link>
    </li>
  );
}
