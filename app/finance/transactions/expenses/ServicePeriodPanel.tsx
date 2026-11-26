"use client";

import { useState } from "react";
import SaveHint from "@/app/components/ui/SaveHint";
import { formatCurrencyCents } from "@/lib/format";
import {
  fullMonthRateCents,
  isSpreadableAccountType,
  recognitionByMonth,
  validateServicePeriod,
  type ServicePeriod,
} from "@/lib/finance/servicePeriod";
import type { CoARef } from "../../AccountSelect";
import type { GlLine } from "./PayrollSplitCell";

/** "6210 · Building & Land Rent": the account's own number and the last part of its name. */
function accountLabel(account: CoARef | undefined): string {
  if (!account) return "an account that no longer exists";
  const name = account.account_name.split(":").pop()!.trim();
  return account.account_number ? `${account.account_number} · ${name}` : name;
}

function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/**
 * Says which months a bill pays for. Once saved, the P&L charges the bill an
 * equal share per month instead of all at once, and the part not yet charged
 * shows on the balance sheet as a prepaid expense.
 */
export function ServicePeriodPanel({
  expenseId,
  glLines,
  accounts,
  accountingDate,
  servicePeriod,
  onUpdated,
  onCancel,
}: {
  expenseId: string;
  /** How the bill is coded: its split lines, or its one account. Empty while it is unmapped. */
  glLines: GlLine[];
  accounts: CoARef[];
  accountingDate: string | null;
  servicePeriod: ServicePeriod | null;
  onUpdated: (next: ServicePeriod | null) => void;
  onCancel: () => void;
}) {
  const [start, setStart] = useState(servicePeriod?.start ?? "");
  const [end, setEnd] = useState(servicePeriod?.end ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Which part of the bill the statements will actually spread. There is
  // nothing to choose here: a line coded to an income or cost account is
  // spread, and a line coded to a balance-sheet account — the seller's share of
  // a bill, a deposit — is a movement on that account on the bill's own date.
  // The panel says so, because a bill split both ways otherwise looks as if
  // the whole of it is about to be spread.
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const spreadLines = glLines.filter((l) => isSpreadableAccountType(accountById.get(l.chartOfAccountsId)?.account_type));
  const heldLines = glLines.filter((l) => !spreadLines.includes(l));
  const amountCents = spreadLines.reduce((sum, l) => sum + l.amountCents, 0);
  const describe = (lines: GlLine[]) =>
    lines.map((l) => `${formatCurrencyCents(l.amountCents)} on ${accountLabel(accountById.get(l.chartOfAccountsId))}`).join(", ");

  const validation = validateServicePeriod({ start, end });
  const billMonth = accountingDate?.slice(0, 7) ?? null;
  const schedule = validation.ok && billMonth ? recognitionByMonth(amountCents, { start, end }, billMonth) : [];
  const monthly = validation.ok ? Math.round(fullMonthRateCents(amountCents, { start, end })) : 0;
  // Months of the period that were already over when the bill arrived are
  // charged in the bill's own month. Worth saying out loud: it is the one place
  // the schedule is not simply "the same amount every month".
  const catchesUp = validation.ok && billMonth !== null && start.slice(0, 7) < billMonth;

  async function send(method: "PUT" | "DELETE") {
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/finance/expenses/${expenseId}/service-period`, {
      method,
      ...(method === "PUT"
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ start_date: start, end_date: end }) }
        : {}),
    });
    setSaving(false);
    const json = (await res.json().catch(() => ({}))) as { error?: string; servicePeriod?: ServicePeriod | null };
    if (!res.ok) {
      setError(json.error ?? "Could not save the months this covers");
      return;
    }
    onUpdated(json.servicePeriod ?? null);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="text-2xs text-faint uppercase tracking-wider">Spread over the months this covers</div>

      <div className="flex items-center gap-2 flex-wrap">
        <label className="flex items-center gap-1.5 text-xs text-secondary">
          First day covered
          <input type="date" className="inp-sm" value={start} onChange={(ev) => setStart(ev.target.value)} />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-secondary">
          Last day covered
          <input type="date" className="inp-sm" value={end} onChange={(ev) => setEnd(ev.target.value)} />
        </label>
        <div className="flex-1" />
        {servicePeriod && (
          <button type="button" className="btn-danger" onClick={() => send("DELETE")} disabled={saving}>
            Stop spreading
          </button>
        )}
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="btn-primary" onClick={() => send("PUT")} disabled={!validation.ok || saving}>
          Save
        </button>
        <SaveHint saving={saving} />
      </div>

      {glLines.length === 0 && (
        <div className="text-2xs text-danger">
          This bill has no GL account yet, so nothing will be spread. Give it an account first.
        </div>
      )}
      {glLines.length > 0 && spreadLines.length === 0 && (
        <div className="text-2xs text-danger">
          Nothing here will be spread: {describe(heldLines)} is a balance sheet account, and only income and cost accounts are charged month by month.
        </div>
      )}
      {spreadLines.length > 0 && heldLines.length > 0 && (
        <div className="text-xs text-secondary">
          <span className="text-body">Spread: {describe(spreadLines)}.</span>{" "}
          Not spread: {describe(heldLines)} — a balance sheet account, so it stays on the bill&apos;s own date.
        </div>
      )}

      {validation.ok && schedule.length > 0 && (
        <div className="text-xs text-secondary">
          <span className="text-body">{formatCurrencyCents(monthly)} a month.</span>{" "}
          {catchesUp
            ? `Months before this bill arrived are charged in ${monthLabel(schedule[0].monthKey)}: ${formatCurrencyCents(schedule[0].amountCents)} that month`
            : `${formatCurrencyCents(schedule[0].amountCents)} in ${monthLabel(schedule[0].monthKey)}`}
          {schedule.length > 1
            ? `, then through ${monthLabel(schedule[schedule.length - 1].monthKey)}. What has not been charged yet shows as a prepaid expense on the balance sheet.`
            : ". Nothing is left to spread — every month it covers had already passed."}
        </div>
      )}
      {!validation.ok && (start || end) && <div className="text-2xs text-danger">{validation.error}</div>}
      {error && <div className="text-2xs text-danger">{error}</div>}
    </div>
  );
}
