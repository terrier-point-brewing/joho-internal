"use client";

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import { formatCurrencyCents } from "@/lib/format";
import Badge from "@/app/components/ui/Badge";
import type { EventTipsData, EventTipMethod } from "@/app/api/taproom/events/[id]/tips/route";

const fmtUsd = (c: number) => formatCurrencyCents(c);

const METHOD_LABEL: Record<EventTipMethod, string> = {
  payroll: "Through payroll",
  cash:    "Cash",
  comp:    "Comped beer",
  other:   "Other",
};

export function useEventTipsQuery(eventId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.taproom.eventTips(eventId),
    queryFn:  () => fetchJson<EventTipsData>(`/api/taproom/events/${eventId}/tips`),
    enabled,
  });
}

interface DraftPayout {
  payee_kind: "employee" | "volunteer";
  employee_id: string;
  payee_name: string;
  method: EventTipMethod;
  amount: string;
  settled_on: string;
  note: string;
}

/**
 * How this event's tips are settled.
 *
 * Event tips never enter the taproom tip pool: the payroll grid carves every
 * event ticket's tip out at source, because the taproom is open while an event
 * runs and event staff are often volunteers. So the manager settles them here,
 * one line per person. An employee's share can go through payroll (it lands on
 * their Paycheck Tips for the event's day); a volunteer's share is settled in
 * cash, as comped beer, or some other way — the carve-out the owner asked for.
 * "Left to settle" is card + cash tips collected minus what has been recorded.
 */
export default function EventTipsPanel({
  eventId, collectedCents, cardCents, cashCents, ended,
}: {
  eventId: string;
  /** Card + cash tips on this event's tickets, from the pours route. */
  collectedCents: number;
  cardCents: number;
  cashCents: number;
  ended: boolean;
}) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useEventTipsQuery(eventId);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<DraftPayout>(() => ({
    payee_kind: "employee", employee_id: "", payee_name: "", method: "payroll", amount: "", settled_on: "", note: "",
  }));
  const [saveError, setSaveError] = useState<string | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: queryKeys.taproom.eventTips(eventId) });
    qc.invalidateQueries({ queryKey: ["payroll"] });
  };

  const addMutation = useMutation({
    mutationFn: async () => {
      const amount_cents = Math.round(parseFloat(draft.amount || "0") * 100);
      const body = {
        payee_kind: draft.payee_kind,
        employee_id: draft.payee_kind === "employee" ? draft.employee_id : undefined,
        payee_name: draft.payee_kind === "volunteer" ? draft.payee_name : undefined,
        method: draft.method,
        amount_cents,
        settled_on: draft.method !== "payroll" && draft.settled_on ? draft.settled_on : undefined,
        note: draft.note || undefined,
      };
      const r = await fetch(`/api/taproom/events/${eventId}/tips`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? "Failed to record payout");
    },
    onSuccess: () => {
      invalidate();
      setAdding(false);
      setSaveError(null);
      setDraft(d => ({ ...d, employee_id: "", payee_name: "", amount: "", note: "" }));
    },
    onError: (e) => setSaveError(e instanceof Error ? e.message : "Failed to record payout"),
  });

  const removeMutation = useMutation({
    mutationFn: async (payoutId: string) => {
      const r = await fetch(`/api/taproom/events/${eventId}/tips/${payoutId}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? "Failed to remove payout");
    },
    onSuccess: invalidate,
    onError: (e) => setSaveError(e instanceof Error ? e.message : "Failed to remove payout"),
  });

  const paid = data?.total_paid_cents ?? 0;
  const remaining = collectedCents - paid;
  const employees = useMemo(() => data?.employees ?? [], [data]);
  const selectedEmp = useMemo(() => employees.find(e => e.id === draft.employee_id), [employees, draft.employee_id]);
  const payrollBlocked = draft.payee_kind === "volunteer" || (selectedEmp ? !selectedEmp.payroll_eligible : false);
  const periodLocked = data?.pay_period?.status === "locked";
  const amountCents = Math.round(parseFloat(draft.amount || "0") * 100);
  const canSave = amountCents > 0
    && (draft.payee_kind === "employee" ? !!draft.employee_id : draft.payee_name.trim().length > 0)
    && !(draft.method === "payroll" && (payrollBlocked || periodLocked));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-xs text-muted uppercase tracking-wide font-medium">Tips</p>
          {collectedCents > 0 && (
            remaining === 0
              ? <Badge tone="success">Settled</Badge>
              : remaining > 0
                ? <Badge tone="neutral" title="Tips collected on event tickets that no payout line accounts for yet">{fmtUsd(remaining)} left to settle</Badge>
                : <Badge tone="danger" title="Payouts exceed the tips this event collected">{fmtUsd(-remaining)} over</Badge>
          )}
        </div>
        {ended && !adding && (
          <button type="button" onClick={() => { setAdding(true); setSaveError(null); }} className={remaining > 0 ? "btn-primary btn-xxs" : "btn-secondary btn-xxs"}>
            Record payout
          </button>
        )}
      </div>

      <p className="text-xs text-muted">
        Collected on event tickets: <span className="font-medium text-strong">{fmtUsd(collectedCents)}</span>
        <span className="text-faint"> ({fmtUsd(cardCents)} card · {fmtUsd(cashCents)} cash)</span>.
        Event tips are kept out of the taproom tip pool; settle them here per person.
      </p>

      {isLoading ? (
        <p className="text-xs text-faint py-2 text-center">Loading…</p>
      ) : error ? (
        <p className="text-xs text-danger">{error instanceof Error ? error.message : "Failed to load"}</p>
      ) : (data?.payouts.length ?? 0) === 0 ? (
        <p className="text-xs text-faint italic py-2">
          {ended ? "No payouts recorded yet." : "Payouts are recorded after the event ends."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line bg-surface/60">
                <th className="text-left px-3 py-2 text-muted font-medium">Who</th>
                <th className="text-left px-3 py-2 text-muted font-medium">How</th>
                <th className="text-right px-3 py-2 text-muted font-medium">Amount</th>
                <th className="text-left px-3 py-2 text-muted font-medium">Note</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line/60">
              {data!.payouts.map((p) => (
                <tr key={p.id}>
                  <td className="px-3 py-2 text-strong">
                    {p.payee_name}
                    <span className="text-faint"> · {p.payee_kind === "volunteer" ? "volunteer" : "employee"}</span>
                  </td>
                  <td className="px-3 py-2 text-body">
                    {METHOD_LABEL[p.method]}
                    {p.method === "payroll" && p.pay_period && (
                      <span className="text-faint"> · {p.pay_period.start_date} – {p.pay_period.end_date}{p.pay_period.status === "locked" ? " (locked)" : ""}</span>
                    )}
                    {p.method !== "payroll" && p.settled_on && <span className="text-faint"> · {p.settled_on}</span>}
                    {p.method === "comp" && p.manual_entry_id && <span className="text-faint"> · booked as event revenue</span>}
                  </td>
                  <td className="px-3 py-2 text-right text-body font-mono">{fmtUsd(p.amount_cents)}</td>
                  <td className="px-3 py-2 text-muted">{p.note ?? "—"}</td>
                  <td className="px-3 py-2 text-right">
                    {!(p.method === "payroll" && p.pay_period?.status === "locked") && (
                      <button type="button" onClick={() => removeMutation.mutate(p.id)} className="btn-secondary btn-xxs" disabled={removeMutation.isPending}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-line-strong bg-surface/60 font-semibold">
                <td className="px-3 py-2 text-body" colSpan={2}>Settled</td>
                <td className="px-3 py-2 text-right text-strong font-mono">{fmtUsd(paid)}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {adding && (
        <form
          className="rounded-lg border border-accent-border/40 bg-accent-muted/10 p-3 space-y-2"
          onSubmit={(e) => { e.preventDefault(); if (canSave) addMutation.mutate(); }}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="block text-xs text-secondary">
              Who
              <select className="inp w-full mt-1" value={draft.payee_kind}
                onChange={(e) => setDraft(d => {
                  const payee_kind = e.target.value as DraftPayout["payee_kind"];
                  return { ...d, payee_kind, method: payee_kind === "volunteer" && d.method === "payroll" ? "cash" : d.method };
                })}>
                <option value="employee">An employee</option>
                <option value="volunteer">A volunteer</option>
              </select>
            </label>
            {draft.payee_kind === "employee" ? (
              <label className="block text-xs text-secondary">
                Employee
                <select className="inp w-full mt-1" value={draft.employee_id} onChange={(e) => setDraft(d => ({ ...d, employee_id: e.target.value }))}>
                  <option value="">Choose…</option>
                  {employees.map(e => <option key={e.id} value={e.id}>{e.name}{e.payroll_eligible ? "" : " (not tipped on payroll)"}</option>)}
                </select>
              </label>
            ) : (
              <label className="block text-xs text-secondary">
                Volunteer&rsquo;s name
                <input className="inp w-full mt-1" value={draft.payee_name} onChange={(e) => setDraft(d => ({ ...d, payee_name: e.target.value }))} placeholder="Name" />
              </label>
            )}
            <label className="block text-xs text-secondary">
              How it was settled
              <select className="inp w-full mt-1" value={draft.method} onChange={(e) => setDraft(d => ({ ...d, method: e.target.value as EventTipMethod }))}>
                {draft.payee_kind === "employee" && <option value="payroll" disabled={payrollBlocked || periodLocked}>Through payroll{periodLocked ? " (period locked)" : ""}</option>}
                <option value="cash">Cash</option>
                <option value="comp">Comped beer</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="block text-xs text-secondary">
              Amount
              <input className="inp w-full mt-1" type="number" min="0.01" step="0.01" inputMode="decimal" value={draft.amount}
                onChange={(e) => setDraft(d => ({ ...d, amount: e.target.value }))} placeholder={remaining > 0 ? (remaining / 100).toFixed(2) : "0.00"} />
            </label>
            {draft.method !== "payroll" && (
              <label className="block text-xs text-secondary">
                Settled on <span className="text-faint">(defaults to the event&rsquo;s day)</span>
                <input className="inp w-full mt-1" type="date" value={draft.settled_on} onChange={(e) => setDraft(d => ({ ...d, settled_on: e.target.value }))} />
              </label>
            )}
            <label className="block text-xs text-secondary sm:col-span-2">
              Note
              <input className="inp w-full mt-1" value={draft.note} onChange={(e) => setDraft(d => ({ ...d, note: e.target.value }))} placeholder="e.g. two pints comped, or share of the jar" />
            </label>
          </div>
          {draft.method === "payroll" && (
            <p className="text-xs text-faint">
              Lands on {selectedEmp?.name ?? "the employee"}&rsquo;s Paycheck Tips for {data?.work_date ?? "the event's day"}
              {data?.pay_period ? ` (pay period ${data.pay_period.start_date} – ${data.pay_period.end_date})` : ""}, on top of any taproom pool share.
            </p>
          )}
          {draft.payee_kind === "volunteer" && draft.method !== "comp" && (
            <p className="text-xs text-faint">A volunteer is not on payroll. Record how their share was settled: cash from the jar, beer comped in lieu, or another arrangement.</p>
          )}
          {draft.method === "comp" && (
            <p className="text-xs text-faint">Comped beer means the tip money stays with the brewery, so this amount is also booked as event revenue (Offsite Event Sales) on the settled date. Removing the payout reverses it.</p>
          )}
          {saveError && <p className="text-xs text-danger">{saveError}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => { setAdding(false); setSaveError(null); }} className="btn-secondary btn-xxs">Cancel</button>
            <button type="submit" className="btn-primary btn-xxs" disabled={!canSave || addMutation.isPending}>
              {addMutation.isPending ? "Saving…" : "Record"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
