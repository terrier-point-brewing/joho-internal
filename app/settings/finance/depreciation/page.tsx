"use client";
/**
 * Depreciation — which fixed-asset accounts depreciate, over what life, and
 * where the charge lands.
 *
 * A schedule is a standing rule, so it lives here (Settings holds rules;
 * Finance does the work). Nothing on this screen posts anything: the P&L's
 * monthly depreciation rows, GL 1590's accumulated figure and retained
 * earnings are all COMPUTED from these rules and the asset accounts' own
 * coded additions — lib/finance/depreciation is the one implementation.
 *
 * ── Life edits apply from this month forward ─────────────────────────────────
 * Changing a life spreads the remaining book value over the remaining new
 * life; months already reported keep their old charge. That is the standard
 * treatment for a change in accounting estimate, and the panel says so where
 * the operator makes the change — there is deliberately no "recompute
 * history" option, because that is error-correction territory and would
 * silently rewrite closed months.
 */
import { useCallback, useEffect, useState } from "react";
import AccountSelect, { type CoARef } from "@/app/finance/AccountSelect";
import SettingsHeader from "@/app/settings/SettingsHeader";
import SaveHint from "@/app/components/ui/SaveHint";
import Banner from "@/app/components/ui/Banner";
import Badge from "@/app/components/ui/Badge";
import { formatCurrencyCents } from "@/lib/format";

const RULES_URL = "/api/finance/depreciation-schedules";

interface ScheduleRow {
  id: string;
  asset_chart_of_accounts_id: string;
  expense_chart_of_accounts_id: string;
  contra_chart_of_accounts_id: string;
  ended_month: string | null;
  life_months: number | null;
  revisions: { effectiveMonth: string | null; lifeMonths: number }[];
  basis_cents: number;
  accumulated_cents: number;
  current_month_expense_cents: number;
  first_addition_month: string | null;
}

function accountLabel(accounts: CoARef[], id: string): string {
  const a = accounts.find((c) => c.id === id);
  if (!a) return "Unknown account";
  const leaf = a.account_name.split(":").pop() ?? a.account_name;
  return a.account_number ? `${a.account_number} · ${leaf}` : leaf;
}

function fmtMonth(month: string | null): string {
  if (!month) return "—";
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** Draft for the "add account" row. */
interface Draft {
  assetCoaId: string;
  expenseCoaId: string;
  contraCoaId: string;
  lifeMonthsRaw: string;
}

export default function DepreciationSettingsPage() {
  const [accounts, setAccounts] = useState<CoARef[]>([]);
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** Per-row raw life input, so typing "8" en route to "84" doesn't save. */
  const [lifeDrafts, setLifeDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [coaRes, rulesRes] = await Promise.all([
        fetch("/api/finance/chart-of-accounts"),
        fetch(RULES_URL),
      ]);
      const [coa, rules] = await Promise.all([coaRes.json(), rulesRes.json()]);
      setAccounts(Array.isArray(coa) ? coa : []);
      setRows(Array.isArray(rules) ? rules : []);
      setLifeDrafts({});
    } catch { setError("Failed to load depreciation schedules."); }
    finally { setLoading(false); }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  async function create(d: Draft) {
    const life = Number(d.lifeMonthsRaw);
    setSavingId("new"); setError(null);
    const res = await fetch(RULES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        asset_chart_of_accounts_id: d.assetCoaId,
        expense_chart_of_accounts_id: d.expenseCoaId,
        contra_chart_of_accounts_id: d.contraCoaId,
        life_months: life,
      }),
    });
    setSavingId(null);
    if (!res.ok) { setError(((await res.json()) as { error?: string }).error ?? "Could not add the schedule"); return; }
    setDraft(null);
    await load();
  }

  async function patch(id: string, body: Record<string, unknown>, failMessage: string) {
    setSavingId(id); setError(null);
    const res = await fetch(RULES_URL, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...body }),
    });
    setSavingId(null);
    if (!res.ok) { setError(((await res.json()) as { error?: string }).error ?? failMessage); return; }
    await load();
  }

  async function remove(id: string) {
    setSavingId(id); setError(null);
    const res = await fetch(RULES_URL, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setSavingId(null);
    if (!res.ok) { setError(((await res.json()) as { error?: string }).error ?? "Could not delete the schedule"); return; }
    await load();
  }

  const scheduled = new Set(rows.map((r) => r.asset_chart_of_accounts_id));
  const fixedAssetAccounts = accounts.filter((a) => a.account_type === "Fixed Assets" && !scheduled.has(a.id));
  const monthlyTotal = rows.filter((r) => !r.ended_month).reduce((s, r) => s + r.current_month_expense_cents, 0);

  const draftValid = draft
    && draft.assetCoaId && draft.expenseCoaId && draft.contraCoaId
    && Number.isInteger(Number(draft.lifeMonthsRaw)) && Number(draft.lifeMonthsRaw) > 0
    && new Set([draft.assetCoaId, draft.expenseCoaId, draft.contraCoaId]).size === 3;

  return (
    <>
      <div className="px-4 sm:px-6">
        <SettingsHeader
          title="Depreciation"
          description="Which fixed-asset accounts depreciate, over how long, and where the charge lands. Everything downstream is computed — nothing is entered each month."
        />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-4 flex flex-col gap-4">
        {error && <Banner>{error}</Banner>}

        {loading ? (
          <p className="text-xs text-muted">Loading…</p>
        ) : (
          <>
            {rows.length > 0 && (
              <p className="text-xs text-secondary">
                {rows.filter((r) => !r.ended_month).length} scheduled account{rows.filter((r) => !r.ended_month).length === 1 ? "" : "s"},
                charging <span className="font-mono tabular-nums text-body">{formatCurrencyCents(Math.abs(monthlyTotal))}</span> this month.
              </p>
            )}

            <div className="overflow-x-auto rounded border border-line/60">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-2xs uppercase tracking-wider text-faint">
                    <th className="px-4 py-2">Asset account</th>
                    <th className="px-4 py-2">Life (months)</th>
                    <th className="px-4 py-2">Expensed to</th>
                    <th className="px-4 py-2 text-right">Basis</th>
                    <th className="px-4 py-2 text-right">Accumulated</th>
                    <th className="px-4 py-2 text-right">This month</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && !draft && (
                    <tr className="border-t border-line/40">
                      <td colSpan={7} className="px-4 py-6 text-center text-secondary">
                        No accounts depreciate yet. Add one to start charging its additions to the P&amp;L, straight-line, from the month they were coded.
                      </td>
                    </tr>
                  )}
                  {rows.map((r) => (
                    <tr key={r.id} className={`border-t border-line/40 ${r.ended_month ? "opacity-60" : ""}`}>
                      <td className="px-4 py-2 text-body">
                        {accountLabel(accounts, r.asset_chart_of_accounts_id)}
                        {r.first_addition_month && (
                          <span className="block text-2xs text-faint">in service {fmtMonth(r.first_addition_month)}</span>
                        )}
                        {r.ended_month && <Badge tone="neutral">ended {fmtMonth(r.ended_month)}</Badge>}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-1.5">
                          <input
                            className="inp-sm w-20 text-right font-mono tabular-nums"
                            value={lifeDrafts[r.id] ?? String(r.life_months ?? "")}
                            onChange={(ev) => setLifeDrafts((d) => ({ ...d, [r.id]: ev.target.value }))}
                            onBlur={(ev) => {
                              const life = Number(ev.target.value);
                              if (Number.isInteger(life) && life > 0 && life !== r.life_months) {
                                patch(r.id, { life_months: life }, "Could not change the life");
                              } else {
                                setLifeDrafts((d) => Object.fromEntries(Object.entries(d).filter(([key]) => key !== r.id)));
                              }
                            }}
                            inputMode="numeric"
                            disabled={!!r.ended_month}
                            aria-label={`Useful life for ${accountLabel(accounts, r.asset_chart_of_accounts_id)}`}
                          />
                          <SaveHint saving={savingId === r.id} />
                        </div>
                        {r.revisions.length > 1 && (
                          <span className="block text-2xs text-faint mt-0.5">
                            {r.revisions
                              .map((rev) => `${rev.lifeMonths}mo ${rev.effectiveMonth ? `from ${fmtMonth(rev.effectiveMonth)}` : "at start"}`)
                              .join(" → ")}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <AccountSelect
                          value={r.expense_chart_of_accounts_id}
                          onChange={(coaId) => { if (coaId) patch(r.id, { expense_chart_of_accounts_id: coaId }, "Could not move the expense account"); }}
                          accounts={accounts}
                          placeholder="— expense account —"
                          shortLabel
                          className="w-full max-w-[240px]"
                        />
                      </td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums text-body">{formatCurrencyCents(r.basis_cents)}</td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums text-body">{formatCurrencyCents(r.accumulated_cents)}</td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums text-body">{formatCurrencyCents(r.current_month_expense_cents)}</td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => patch(r.id, { ended: !r.ended_month }, "Could not change the schedule")}
                          disabled={savingId === r.id}
                        >
                          {r.ended_month ? "Resume" : "Stop"}
                        </button>{" "}
                        <button
                          type="button"
                          className="btn-danger"
                          onClick={() => remove(r.id)}
                          disabled={savingId === r.id}
                          title="Only a schedule added this month can be deleted; older ones are stopped instead, so past months keep what they reported."
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                  {draft && (
                    <tr className="border-t border-line/40 bg-surface-mid/20">
                      <td className="px-4 py-2">
                        <AccountSelect
                          value={draft.assetCoaId || null}
                          onChange={(coaId) => setDraft({ ...draft, assetCoaId: coaId ?? "" })}
                          accounts={fixedAssetAccounts}
                          placeholder="— fixed-asset account —"
                          shortLabel
                          className="w-full max-w-[240px]"
                        />
                      </td>
                      <td className="px-4 py-2">
                        <input
                          className="inp-sm w-20 text-right font-mono tabular-nums"
                          value={draft.lifeMonthsRaw}
                          onChange={(ev) => setDraft({ ...draft, lifeMonthsRaw: ev.target.value })}
                          inputMode="numeric"
                          placeholder="84"
                          aria-label="Useful life in months"
                        />
                      </td>
                      <td className="px-4 py-2">
                        <AccountSelect
                          value={draft.expenseCoaId || null}
                          onChange={(coaId) => setDraft({ ...draft, expenseCoaId: coaId ?? "" })}
                          accounts={accounts}
                          placeholder="— expense account —"
                          shortLabel
                          className="w-full max-w-[240px]"
                        />
                      </td>
                      <td className="px-4 py-2" colSpan={2}>
                        <AccountSelect
                          value={draft.contraCoaId || null}
                          onChange={(coaId) => setDraft({ ...draft, contraCoaId: coaId ?? "" })}
                          accounts={accounts}
                          placeholder="— accumulated depreciation account —"
                          shortLabel
                          className="w-full max-w-[260px]"
                        />
                      </td>
                      <td className="px-4 py-2" />
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        <button type="button" className="btn-secondary" onClick={() => setDraft(null)}>Cancel</button>{" "}
                        <button type="button" className="btn-primary" onClick={() => draftValid && create(draft)} disabled={!draftValid || savingId === "new"}>
                          Add
                        </button>
                        <SaveHint saving={savingId === "new"} />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {!draft && (
              <button
                type="button"
                className="btn-secondary self-start"
                onClick={() => setDraft({ assetCoaId: "", expenseCoaId: "", contraCoaId: "", lifeMonthsRaw: "" })}
                disabled={fixedAssetAccounts.length === 0}
              >
                Add account
              </button>
            )}

            <p className="text-2xs text-faint leading-relaxed max-w-3xl">
              Each month&apos;s additions to a scheduled account depreciate straight-line from the month they were coded, over the life above.
              The charge appears on the P&amp;L automatically and accumulates on the balance sheet — nothing is entered by hand.
              Changing a life applies <span className="text-body">from this month forward</span>: the remaining book value spreads over the remaining new life,
              and months already reported keep their old charge. That is the standard treatment for a change in estimate — history is never rewritten from here.
            </p>
          </>
        )}
      </div>
    </>
  );
}
