"use client";

import { Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import type { TipPoolFrequency } from "@/lib/payroll/types";
import { fmtCents } from "@/lib/utils/formatting";

interface ShiftRow {
  employee_id: string;
  name: string;
  daily_hours: Record<string, number>;
  total_hours: number;
  daily_tips_cents: Record<string, number> | null;
  total_tips_cents: number | null;
  daily_cash_tips_cents: Record<string, number> | null;
  total_cash_tips_cents: number | null;
}

interface ShiftData {
  days: string[];
  tip_pool_frequency: TipPoolFrequency;
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

export function ShiftTimeline({ periodId }: { periodId: string }) {
  const { data, isLoading, error } = useQuery<ShiftData>({
    queryKey: queryKeys.payroll.shifts(periodId),
    queryFn: () =>
      fetch(`/api/payroll/periods/${periodId}/shifts`).then(async r => {
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          throw new Error((d as { error?: string }).error ?? "Failed to load shifts");
        }
        return r.json();
      }),
    staleTime: 60_000,
  });

  if (isLoading) return <p className="text-zinc-500 text-sm py-6">Loading shifts…</p>;
  if (error) return <p className="text-red-400 text-sm py-6">{(error as Error).message}</p>;
  if (!data || data.rows.length === 0) {
    return <p className="text-zinc-600 text-sm py-6">No closed shifts found for this period.</p>;
  }

  const { days, rows, tip_pool_frequency } = data;
  const hasTippedRows = rows.some(r => r.daily_tips_cents !== null);
  const hasCashTipRows = rows.some(r => r.daily_cash_tips_cents !== null);

  // Chunk days into 7-day weeks
  const weeks: string[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  const multiWeek = weeks.length > 1;

  // Card height depends on how many tip rows are shown
  const cardH = hasCashTipRows ? "h-20" : hasTippedRows ? "h-16" : "h-10";

  return (
    <div className="overflow-x-auto">
      <table className="text-xs border-collapse">
        <thead>
          <tr>
            <th className="text-left py-2 pr-8 text-zinc-500 font-medium whitespace-nowrap">Employee</th>
            {weeks.map((week, wi) => (
              <Fragment key={wi}>
                {week.map(d => (
                  <th key={d} className="px-1 py-2 text-zinc-500 font-normal text-center w-20">
                    {dayLabel(d)}
                  </th>
                ))}
                {multiWeek && (
                  <th className="pl-3 pr-2 py-2 text-zinc-400 font-medium text-right whitespace-nowrap border-l border-zinc-800">
                    Wk {wi + 1}
                  </th>
                )}
              </Fragment>
            ))}
            <th className={`py-2 text-zinc-500 font-medium text-right whitespace-nowrap ${multiWeek ? "pl-3 pr-0 border-l border-zinc-800" : "pl-5"}`}>
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const isTipped = row.daily_tips_cents !== null;
            const hasCash = row.daily_cash_tips_cents !== null;
            return (
              <tr key={row.employee_id} className={i > 0 ? "border-t border-transparent" : ""}>
                <td className="pr-8 py-1 text-zinc-300 whitespace-nowrap font-medium align-middle">
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
                        return (
                          <td key={d} className="px-1 py-1 align-top">
                            {h > 0 ? (
                              <div className={`w-20 ${cardH} rounded-lg px-3 py-2 flex flex-col justify-center gap-0.5 ${hourCellStyle(h)}`}>
                                <span className="text-sm font-mono font-semibold leading-none">
                                  {h.toFixed(1)}h
                                </span>
                                {isTipped && (
                                  <span className={`text-xs font-mono leading-none ${t && t > 0 ? "text-emerald-400" : "text-zinc-600"}`}>
                                    {t && t > 0 ? fmtCents(t) : "—"}
                                  </span>
                                )}
                                {hasCash && (
                                  <span className={`text-xs font-mono leading-none ${ct && ct > 0 ? "text-amber-300" : "text-zinc-700"}`}>
                                    {ct && ct > 0 ? fmtCents(ct) : "—"}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <div className={`w-20 ${cardH} rounded-lg bg-zinc-900/30`} />
                            )}
                          </td>
                        );
                      })}

                      {/* Week subtotal column */}
                      {multiWeek && (
                        <td className="pl-3 pr-2 py-1 align-top border-l border-zinc-800">
                          {wkHours > 0 ? (
                            <div className={`w-20 ${cardH} rounded-lg px-3 py-2 flex flex-col justify-center gap-0.5 bg-zinc-800 border border-zinc-700`}>
                              <span className="text-sm font-mono font-semibold leading-none text-zinc-200">
                                {wkHours.toFixed(1)}h
                              </span>
                              {isTipped && (
                                <span className={`text-xs font-mono leading-none ${wkTips && wkTips > 0 ? "text-emerald-400" : "text-zinc-600"}`}>
                                  {wkTips && wkTips > 0 ? fmtCents(wkTips) : "—"}
                                </span>
                              )}
                              {hasCash && (
                                <span className={`text-xs font-mono leading-none ${wkCashTips && wkCashTips > 0 ? "text-amber-300" : "text-zinc-700"}`}>
                                  {wkCashTips && wkCashTips > 0 ? fmtCents(wkCashTips) : "—"}
                                </span>
                              )}
                            </div>
                          ) : (
                            <div className={`w-20 ${cardH} rounded-lg bg-zinc-800/30 border border-zinc-800/50`} />
                          )}
                        </td>
                      )}
                    </Fragment>
                  );
                })}

                {/* Period total */}
                <td className={`py-1 align-middle text-right whitespace-nowrap ${multiWeek ? "pl-3 border-l border-zinc-800" : "pl-5"}`}>
                  <div className="flex flex-col items-end gap-0.5">
                    <span className="text-zinc-300 font-medium font-mono">{row.total_hours.toFixed(1)}h</span>
                    {isTipped && row.total_tips_cents != null && row.total_tips_cents > 0 && (
                      <span className="text-emerald-400 font-mono">{fmtCents(row.total_tips_cents)}</span>
                    )}
                    {hasCash && row.total_cash_tips_cents != null && row.total_cash_tips_cents > 0 && (
                      <span className="text-amber-300 font-mono">{fmtCents(row.total_cash_tips_cents)}</span>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-zinc-700">
            <td className="pr-8 py-2 text-zinc-500 font-medium text-xs whitespace-nowrap align-middle">Total</td>
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
                            <span className="font-mono text-zinc-400">{dayHours.toFixed(1)}h</span>
                            {dayTips != null && dayTips > 0 && (
                              <span className="font-mono text-emerald-800 text-xs">{fmtCents(dayTips)}</span>
                            )}
                            {dayCashTips != null && dayCashTips > 0 && (
                              <span className="font-mono text-amber-700 text-xs">{fmtCents(dayCashTips)}</span>
                            )}
                          </div>
                        ) : (
                          <span className="text-zinc-800">—</span>
                        )}
                      </td>
                    );
                  })}
                  {multiWeek && (
                    <td className="pl-3 pr-2 py-2 align-middle border-l border-zinc-800 text-right">
                      <div className="flex flex-col items-end gap-0.5">
                        <span className="font-mono font-semibold text-zinc-300">{wkTotalHours.toFixed(1)}h</span>
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
            <td className={`py-2 align-middle text-right whitespace-nowrap ${multiWeek ? "pl-3 border-l border-zinc-800" : "pl-5"}`}>
              <div className="flex flex-col items-end gap-0.5">
                <span className="font-mono font-semibold text-zinc-200">
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
          </tr>
        </tfoot>
      </table>

      <div className="flex items-center gap-4 mt-4 text-zinc-700 text-xs">
        <span>Hours per shift start date (local time)</span>
        {hasTippedRows && (
          <span className="text-emerald-900">Card tips from {FREQ_LABELS[tip_pool_frequency]} pool</span>
        )}
        {hasCashTipRows && (
          <span className="text-amber-900">Cash tips from {FREQ_LABELS[tip_pool_frequency]} pool</span>
        )}
      </div>
    </div>
  );
}
