"use client";

import { Fragment, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import type { TipPoolFrequency } from "@/lib/payroll/types";
import { fmtCents } from "@/lib/utils/formatting";
import Banner from "@/app/components/ui/Banner";

interface DayOverrideCell {
  adj_hours: number | null;
  adj_paycheck_tips_cents: number | null;
  adj_cash_tips_cents: number | null;
  note: string | null;
}

interface ShiftRow {
  employee_id: string;
  name: string;
  overridable: boolean;
  daily_hours: Record<string, number>;
  total_hours: number;
  daily_tips_cents: Record<string, number> | null;
  total_tips_cents: number | null;
  daily_cash_tips_cents: Record<string, number> | null;
  total_cash_tips_cents: number | null;
  overrides: Record<string, DayOverrideCell>;
  source_hours: Record<string, number>;
  source_tips_cents: Record<string, number> | null;
  source_cash_tips_cents: Record<string, number> | null;
}

interface TipBucket {
  label: string; days: string[];
  pool_cents: number; pinned_cents: number; attributed_cents: number;
}

interface ShiftData {
  days: string[];
  tip_pool_frequency: TipPoolFrequency;
  tip_buckets: TipBucket[];
  pool_variance: Array<{ label: string; pool_cents: number; attributed_cents: number }>;
  rows: ShiftRow[];
}

function hourCellStyle(h: number): string {
  if (h <= 0) return "bg-zinc-900 text-zinc-800";
  if (h < 4)  return "bg-amber-900/30 text-amber-600";
  if (h < 7)  return "bg-amber-900/50 text-amber-400";
  return "bg-amber-800/60 text-amber-200";
}

function dayLabel(d: string): string {
  const [, m, day] = d.split("-");
  return `${parseInt(m)}/${parseInt(day)}`;
}

const FREQ_LABELS: Record<TipPoolFrequency, string> = {
  daily:    "daily",
  weekly:   "weekly",
  biweekly: "biweekly",
};

type Field = "hours" | "card" | "cash";
const editKey = (emp: string, date: string, f: Field) => `${emp}|${date}|${f}`;

function CardLine({
  value, source, overridden, editable, editing, draft,
  onFocus, onBlur, onChange, className,
}: {
  value: string; source: string; overridden: boolean;
  editable: boolean; editing: boolean; draft: string;
  onFocus: () => void; onBlur: () => void; onChange: (v: string) => void; className: string;
}) {
  if (editable && editing) {
    return (
      <input
        autoFocus
        type="number"
        min="0"
        step="0.01"
        value={draft}
        onChange={e => onChange(e.target.value)}
        onBlur={onBlur}
        className="inp-sm w-full text-right font-mono text-xs px-1 py-0"
      />
    );
  }
  return (
    <button
      type="button"
      disabled={!editable}
      onClick={onFocus}
      className={`text-left leading-none font-mono text-xs ${
        overridden ? "text-accent" : className
      } ${editable ? "cursor-text" : "cursor-default"}`}
    >
      {value}
      {overridden && <span className="ml-1 text-faint line-through">{source}</span>}
    </button>
  );
}

export function ShiftTimeline({ periodId, overrideMode }: { periodId: string; overrideMode: boolean }) {
  const qc = useQueryClient();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [focused, setFocused] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [savingRow, setSavingRow] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery<ShiftData>({
    queryKey: queryKeys.payroll.shifts(periodId, overrideMode),
    queryFn: () =>
      fetch(`/api/payroll/periods/${periodId}/shifts${overrideMode ? "?override=1" : ""}`).then(async r => {
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          throw new Error((d as { error?: string }).error ?? "Failed to load shifts");
        }
        return r.json();
      }),
    staleTime: 60_000,
  });

  if (isLoading) return <p className="text-muted text-sm py-6">Loading shifts…</p>;
  if (error) return <p className="text-danger text-sm py-6">{(error as Error).message}</p>;
  if (!data || data.rows.length === 0) {
    return <p className="text-faint text-sm py-6">No closed shifts found for this period.</p>;
  }

  const { days, rows, tip_pool_frequency } = data;
  const hasTippedRows = rows.some(r => r.daily_tips_cents !== null);
  const hasCashTipRows = rows.some(r => r.daily_cash_tips_cents !== null);

  async function saveRow(row: ShiftRow) {
    setSavingRow(row.employee_id);
    try {
      const byDate = new Map<string, DayOverrideCell>();
      const rowPrefix = `${row.employee_id}|`;
      for (const day of days) {
        const existing = row.overrides[day];
        const g = (f: Field) => {
          const k = editKey(row.employee_id, day, f);
          return k in edits ? (edits[k] === "" ? null : Number(edits[k])) : undefined;
        };
        const h = g("hours"), card = g("card"), cash = g("cash");
        if (h === undefined && card === undefined && cash === undefined && !existing) continue;
        const dayTouched = h !== undefined || card !== undefined || cash !== undefined;
        byDate.set(day, {
          adj_hours: h === undefined ? existing?.adj_hours ?? null : h,
          adj_paycheck_tips_cents: card === undefined
            ? existing?.adj_paycheck_tips_cents ?? null
            : card === null ? null : Math.round(card * 100),
          adj_cash_tips_cents: cash === undefined
            ? existing?.adj_cash_tips_cents ?? null
            : cash === null ? null : Math.round(cash * 100),
          // Only cells actually edited in this save get stamped with the
          // note — untouched pre-existing cells keep whatever note they had.
          note: dayTouched ? (notes[row.employee_id] ?? existing?.note ?? null) : existing?.note ?? null,
        });
      }

      const res = await fetch(`/api/payroll/periods/${periodId}/shift-overrides/${row.employee_id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cells: [...byDate].map(([work_date, c]) => ({ work_date, ...c })) }),
      });

      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "Save failed" }));
        setSaveError(error);
        return;
      }
      setSaveError(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.payroll.shiftsAll(periodId) }),
        qc.invalidateQueries({ queryKey: queryKeys.payroll.preview(periodId) }),
      ]);
      // Clear only this row's pending edits — other rows' unsaved edits
      // must survive the refetch.
      setEdits(e => Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith(rowPrefix))));
      setNotes(n => {
        const rest = { ...n };
        delete rest[row.employee_id];
        return rest;
      });
      setFocused(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSavingRow(null);
    }
  }

  // Chunk days into 7-day weeks
  const weeks: string[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  const multiWeek = weeks.length > 1;

  // Card height depends on how many tip rows are shown
  const cardH = hasCashTipRows ? "h-20" : hasTippedRows ? "h-16" : "h-10";

  return (
    <div className="overflow-x-auto">
      {overrideMode && (
        <Banner tone="info" className="mb-3">
          Card tips rebalance within {data.tip_buckets.length <= 1
            ? "the whole period"
            : `each ${FREQ_LABELS[tip_pool_frequency]} pool (${data.tip_buckets[0]?.label ?? ""}, …)`}
          . Editing one cell moves the others in that span.
        </Banner>
      )}
      {data.pool_variance.map(v => (
        <Banner key={v.label} tone={v.attributed_cents > v.pool_cents ? "danger" : "neutral"} className="mb-3">
          {v.attributed_cents > v.pool_cents
            ? `Pinned card tips for ${v.label} exceed the pool by ${fmtCents(v.attributed_cents - v.pool_cents)} — revise them.`
            : `${fmtCents(v.pool_cents - v.attributed_cents)} of the ${v.label} pool is unattributed (no eligible hours).`}
        </Banner>
      ))}
      {saveError && <Banner tone="danger" className="mb-3">{saveError}</Banner>}
      <table className="text-xs border-collapse">
        <thead>
          <tr>
            <th className="sticky left-0 z-20 bg-canvas shadow-[1px_0_0_0_var(--color-line)] text-left py-2 pr-8 text-muted font-medium whitespace-nowrap">Employee</th>
            {weeks.map((week, wi) => (
              <Fragment key={wi}>
                {week.map(d => (
                  <th key={d} className="px-1 py-2 text-muted font-normal text-center w-20">
                    {dayLabel(d)}
                  </th>
                ))}
                {multiWeek && (
                  <th className="pl-3 pr-2 py-2 text-secondary font-medium text-right whitespace-nowrap border-l border-line">
                    Wk {wi + 1}
                  </th>
                )}
              </Fragment>
            ))}
            <th className={`py-2 text-muted font-medium text-right whitespace-nowrap ${multiWeek ? "pl-3 pr-0 border-l border-line" : "pl-5"}`}>
              Total
            </th>
            {overrideMode && <th className="sticky right-0 z-20 bg-canvas shadow-[-1px_0_0_0_var(--color-line)]" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const isTipped = row.daily_tips_cents !== null;
            const hasCash = row.daily_cash_tips_cents !== null;
            return (
              <tr key={row.employee_id} className={i > 0 ? "border-t border-transparent" : ""}>
                <td className="sticky left-0 z-10 bg-canvas shadow-[1px_0_0_0_var(--color-line)] pr-8 py-1 text-body whitespace-nowrap font-medium align-middle">
                  {row.name}
                </td>

                {weeks.map((week, wi) => {
                  const wkHours    = week.reduce((s, d) => s + (row.daily_hours[d] ?? 0), 0);
                  const wkTips     = isTipped ? week.reduce((s, d) => s + (row.daily_tips_cents![d] ?? 0), 0) : null;
                  const wkCashTips = hasCash   ? week.reduce((s, d) => s + (row.daily_cash_tips_cents![d] ?? 0), 0) : null;

                  return (
                    <Fragment key={wi}>
                      {/* Day cards */}
                      {week.map(d => {
                        const h  = row.daily_hours[d] ?? 0;
                        const t  = isTipped ? (row.daily_tips_cents![d] ?? 0) : null;
                        const ct = hasCash   ? (row.daily_cash_tips_cents![d] ?? 0) : null;
                        const ov = row.overrides[d];
                        const canEdit = overrideMode && row.overridable;
                        const show = h > 0 || canEdit;
                        return (
                          <td key={d} className="px-1 py-1 align-top">
                            {show ? (
                              <div className={`w-20 ${cardH} rounded-lg px-3 py-2 flex flex-col justify-center gap-0.5 ${
                                h > 0 ? hourCellStyle(h) : "border border-line-strong"
                              }`}>
                                <CardLine
                                  value={`${h.toFixed(1)}h`}
                                  source={`${(row.source_hours[d] ?? 0).toFixed(1)}h`}
                                  overridden={ov?.adj_hours != null}
                                  editable={canEdit}
                                  editing={focused === editKey(row.employee_id, d, "hours")}
                                  draft={edits[editKey(row.employee_id, d, "hours")] ?? String(h)}
                                  onFocus={() => setFocused(editKey(row.employee_id, d, "hours"))}
                                  onBlur={() => setFocused(null)}
                                  onChange={v => setEdits(e => ({ ...e, [editKey(row.employee_id, d, "hours")]: v }))}
                                  className="text-sm font-semibold"
                                />
                                {isTipped && (
                                  <CardLine
                                    value={t && t > 0 ? fmtCents(t) : "—"}
                                    source={fmtCents(row.source_tips_cents?.[d] ?? 0)}
                                    overridden={ov?.adj_paycheck_tips_cents != null}
                                    editable={canEdit}
                                    editing={focused === editKey(row.employee_id, d, "card")}
                                    draft={edits[editKey(row.employee_id, d, "card")] ?? String((t ?? 0) / 100)}
                                    onFocus={() => setFocused(editKey(row.employee_id, d, "card"))}
                                    onBlur={() => setFocused(null)}
                                    onChange={v => setEdits(e => ({ ...e, [editKey(row.employee_id, d, "card")]: v }))}
                                    className="text-emerald-400"
                                  />
                                )}
                                {hasCash && (
                                  <CardLine
                                    value={ct && ct > 0 ? fmtCents(ct) : "—"}
                                    source={fmtCents(row.source_cash_tips_cents?.[d] ?? 0)}
                                    overridden={ov?.adj_cash_tips_cents != null}
                                    editable={canEdit}
                                    editing={focused === editKey(row.employee_id, d, "cash")}
                                    draft={edits[editKey(row.employee_id, d, "cash")] ?? String((ct ?? 0) / 100)}
                                    onFocus={() => setFocused(editKey(row.employee_id, d, "cash"))}
                                    onBlur={() => setFocused(null)}
                                    onChange={v => setEdits(e => ({ ...e, [editKey(row.employee_id, d, "cash")]: v }))}
                                    className="text-amber-300"
                                  />
                                )}
                              </div>
                            ) : (
                              <div className={`w-20 ${cardH} rounded-lg bg-surface/30`} />
                            )}
                          </td>
                        );
                      })}

                      {/* Week subtotal column */}
                      {multiWeek && (
                        <td className="pl-3 pr-2 py-1 align-top border-l border-line">
                          {wkHours > 0 ? (
                            <div className={`w-20 ${cardH} rounded-lg px-3 py-2 flex flex-col justify-center gap-0.5 bg-surface-mid border border-line-strong`}>
                              <span className="text-sm font-mono font-semibold leading-none text-strong">
                                {wkHours.toFixed(1)}h
                              </span>
                              {isTipped && (
                                <span className={`text-xs font-mono leading-none ${wkTips && wkTips > 0 ? "text-emerald-400" : "text-faint"}`}>
                                  {wkTips && wkTips > 0 ? fmtCents(wkTips) : "—"}
                                </span>
                              )}
                              {hasCash && (
                                <span className={`text-xs font-mono leading-none ${wkCashTips && wkCashTips > 0 ? "text-amber-300" : "text-disabled"}`}>
                                  {wkCashTips && wkCashTips > 0 ? fmtCents(wkCashTips) : "—"}
                                </span>
                              )}
                            </div>
                          ) : (
                            <div className={`w-20 ${cardH} rounded-lg bg-surface-mid/30 border border-line/50`} />
                          )}
                        </td>
                      )}
                    </Fragment>
                  );
                })}

                {/* Period total */}
                <td className={`py-1 align-middle text-right whitespace-nowrap ${multiWeek ? "pl-3 border-l border-line" : "pl-5"}`}>
                  <div className="flex flex-col items-end gap-0.5">
                    <span className="text-body font-medium font-mono">{row.total_hours.toFixed(1)}h</span>
                    {isTipped && row.total_tips_cents != null && row.total_tips_cents > 0 && (
                      <span className="text-emerald-400 font-mono">{fmtCents(row.total_tips_cents)}</span>
                    )}
                    {hasCash && row.total_cash_tips_cents != null && row.total_cash_tips_cents > 0 && (
                      <span className="text-amber-300 font-mono">{fmtCents(row.total_cash_tips_cents)}</span>
                    )}
                  </div>
                </td>

                {overrideMode && row.overridable && (
                  <td className="sticky right-0 z-10 bg-canvas shadow-[-1px_0_0_0_var(--color-line)] pl-4 pr-2 py-1 align-middle">
                    <div className="flex gap-2 items-center">
                      <input
                        type="text"
                        value={notes[row.employee_id] ?? ""}
                        onChange={e => setNotes(n => ({ ...n, [row.employee_id]: e.target.value }))}
                        placeholder="Notes…"
                        className="inp-sm w-32"
                      />
                      <button
                        onClick={() => saveRow(row)}
                        disabled={savingRow === row.employee_id}
                        className="btn-secondary btn-xxs"
                      >
                        {savingRow === row.employee_id ? "…" : "Save"}
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-line-strong">
            <td className="sticky left-0 z-20 bg-canvas shadow-[1px_0_0_0_var(--color-line)] pr-8 py-2 text-muted font-medium text-xs whitespace-nowrap align-middle">Total</td>
            {weeks.map((week, wi) => {
              const wkTotalHours    = week.reduce((s, d) =>
                s + rows.reduce((rs, r) => rs + (r.daily_hours[d] ?? 0), 0), 0);
              const wkTotalTips     = hasTippedRows
                ? week.reduce((s, d) => s + rows.reduce((rs, r) => rs + (r.daily_tips_cents?.[d] ?? 0), 0), 0)
                : null;
              const wkTotalCashTips = hasCashTipRows
                ? week.reduce((s, d) => s + rows.reduce((rs, r) => rs + (r.daily_cash_tips_cents?.[d] ?? 0), 0), 0)
                : null;

              return (
                <Fragment key={wi}>
                  {week.map(d => {
                    const dayHours    = rows.reduce((s, r) => s + (r.daily_hours[d] ?? 0), 0);
                    const dayTips     = hasTippedRows  ? rows.reduce((s, r) => s + (r.daily_tips_cents?.[d] ?? 0), 0) : null;
                    const dayCashTips = hasCashTipRows ? rows.reduce((s, r) => s + (r.daily_cash_tips_cents?.[d] ?? 0), 0) : null;
                    return (
                      <td key={d} className="px-1 py-2 align-middle text-center">
                        {dayHours > 0 ? (
                          <div className="flex flex-col items-center gap-0.5">
                            <span className="font-mono text-secondary">{dayHours.toFixed(1)}h</span>
                            {dayTips != null && dayTips > 0 && (
                              <span className="font-mono text-emerald-800 text-xs">{fmtCents(dayTips)}</span>
                            )}
                            {dayCashTips != null && dayCashTips > 0 && (
                              <span className="font-mono text-amber-700 text-xs">{fmtCents(dayCashTips)}</span>
                            )}
                          </div>
                        ) : (
                          <span className="text-disabled">—</span>
                        )}
                      </td>
                    );
                  })}
                  {multiWeek && (
                    <td className="pl-3 pr-2 py-2 align-middle border-l border-line text-right">
                      <div className="flex flex-col items-end gap-0.5">
                        <span className="font-mono font-semibold text-body">{wkTotalHours.toFixed(1)}h</span>
                        {wkTotalTips != null && wkTotalTips > 0 && (
                          <span className="font-mono text-emerald-400 text-xs">{fmtCents(wkTotalTips)}</span>
                        )}
                        {wkTotalCashTips != null && wkTotalCashTips > 0 && (
                          <span className="font-mono text-amber-300 text-xs">{fmtCents(wkTotalCashTips)}</span>
                        )}
                      </div>
                    </td>
                  )}
                </Fragment>
              );
            })}
            <td className={`py-2 align-middle text-right whitespace-nowrap ${multiWeek ? "pl-3 border-l border-line" : "pl-5"}`}>
              <div className="flex flex-col items-end gap-0.5">
                <span className="font-mono font-semibold text-strong">
                  {rows.reduce((s, r) => s + r.total_hours, 0).toFixed(1)}h
                </span>
                {hasTippedRows && (() => {
                  const grandTips = rows.reduce((s, r) => s + (r.total_tips_cents ?? 0), 0);
                  return grandTips > 0
                    ? <span className="font-mono text-emerald-400">{fmtCents(grandTips)}</span>
                    : null;
                })()}
                {hasCashTipRows && (() => {
                  const grandCash = rows.reduce((s, r) => s + (r.total_cash_tips_cents ?? 0), 0);
                  return grandCash > 0
                    ? <span className="font-mono text-amber-300">{fmtCents(grandCash)}</span>
                    : null;
                })()}
              </div>
            </td>
            {overrideMode && <td className="sticky right-0 z-20 bg-canvas shadow-[-1px_0_0_0_var(--color-line)]" />}
          </tr>
        </tfoot>
      </table>

      <div className="flex items-center gap-4 mt-4 text-disabled text-xs">
        <span>Hours per shift start date (local time)</span>
        {hasTippedRows && (
          <span className="text-emerald-900">Card tips from {FREQ_LABELS[tip_pool_frequency]} pool</span>
        )}
        {hasCashTipRows && (
          <span className="text-amber-900">Declared cash tips (Square)</span>
        )}
      </div>
    </div>
  );
}
