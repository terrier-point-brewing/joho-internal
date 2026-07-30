"use client";
// Balance Sheet Accounts settings screen (spec §4.5/§6): declares which
// balance provider(s) (lib/finance/balances/registry.ts) feed each
// balance-sheet account's monthly snapshot. RULES ONLY -- no editable dollar
// value exists anywhere on this screen. An account carries a LIST of sources
// (e.g. GL 2220 = taxAccrual + transactionPostings), added/removed
// independently; the "Current Balance" column is read-only, broken out per
// provider via gl_account_balances.contributions, so a balance is explainable
// without leaving this screen. A manualBalance-sourced row deep-links to
// Finance > Transactions > Manual Entries instead of an inline dollar input
// -- Settings holds rules, Transactions holds values (PR A's whole point).
//
// Gated on CAP.financeTransactionsManage via app/settings/finance/layout.tsx
// (the whole /settings/finance/* group), same as every sibling page here --
// no redundant per-page gate.
//
// Modeled on app/settings/finance/sales-tax-accounts/page.tsx's structure
// (load-all, per-row inline actions, SaveHint feedback) with react-query
// swapped in for the fetch/invalidate cycle since this task's brief also
// wires lib/query-keys.ts's new balanceSources key.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import { formatCurrencyCents } from "@/lib/format";
import Banner from "@/app/components/ui/Banner";
import Card from "@/app/components/ui/Card";
import Badge from "@/app/components/ui/Badge";

interface ProviderMeta {
  key: string;
  label: string;
  kind: "derived" | "integration" | "manual";
}

interface SourceEntry {
  providerKey: string;
  config: Record<string, unknown>;
  active: boolean;
  updatedAt: string;
}

interface CurrentBalance {
  periodEnd: string;
  cents: number;
  contributions: Record<string, number>;
}

interface AccountRow {
  id: string;
  accountName: string;
  accountNumber: string | null;
  statementSection: string | null;
  sources: SourceEntry[];
  availableProviderKeys: string[];
  currentBalance: CurrentBalance | null;
}

interface BalanceSourcesResponse {
  accounts: AccountRow[];
  providers: ProviderMeta[];
}

const MANUAL_ENTRIES_HREF = "/finance/transactions/manual-entries";

async function putSource(coaId: string, providerKey: string, active?: boolean) {
  const res = await fetch("/api/finance/balance-sources", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(active === undefined ? { coaId, providerKey } : { coaId, providerKey, active }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Could not save that source.");
}

async function deleteSource(coaId: string, providerKey: string) {
  const res = await fetch("/api/finance/balance-sources", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ coaId, providerKey }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Could not remove that source.");
}

/** Account name with GL number prefix, matching every other finance table's convention. */
function accountLabel(a: AccountRow): string {
  return a.accountNumber ? `${a.accountNumber} · ${a.accountName}` : a.accountName;
}

export default function BalanceSheetAccountsPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [pendingProvider, setPendingProvider] = useState<Record<string, string>>({});

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.finance.balanceSources(),
    queryFn: () => fetchJson<BalanceSourcesResponse>("/api/finance/balance-sources"),
  });

  const providerLabel = (key: string) => data?.providers.find((p) => p.key === key)?.label ?? key;

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: queryKeys.finance.balanceSources() });
  }

  async function handleAdd(account: AccountRow) {
    const providerKey = pendingProvider[account.id];
    if (!providerKey) return;
    setSavingKey(`${account.id}:${providerKey}`);
    setError(null);
    try {
      await putSource(account.id, providerKey);
      setPendingProvider((p) => ({ ...p, [account.id]: "" }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add that source.");
    } finally {
      setSavingKey(null);
    }
  }

  async function handleToggleActive(account: AccountRow, source: SourceEntry) {
    const key = `${account.id}:${source.providerKey}`;
    setSavingKey(key);
    setError(null);
    try {
      await putSource(account.id, source.providerKey, !source.active);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update that source.");
    } finally {
      setSavingKey(null);
    }
  }

  async function handleRemove(account: AccountRow, source: SourceEntry) {
    const key = `${account.id}:${source.providerKey}`;
    setSavingKey(key);
    setError(null);
    try {
      await deleteSource(account.id, source.providerKey);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove that source.");
    } finally {
      setSavingKey(null);
    }
  }

  const accounts = data?.accounts ?? [];
  const sourcedCount = accounts.filter((a) => a.sources.some((s) => s.active)).length;

  return (
    <>
      <div className="shrink-0 px-4 sm:px-6 pt-4 pb-2">
        <p className="text-sm text-muted">
          {accounts.length > 0
            ? `${sourcedCount} of ${accounts.length} balance-sheet accounts have an active source`
            : "Balance-sheet accounts appear here once the chart of accounts is mapped."}
        </p>
        <p className="text-2xs text-faint mt-1">
          Rules only — declares which provider(s) compute each account&apos;s monthly balance. An account can carry
          several sources at once (e.g. a tax-collections accrual plus its own transaction postings). Dollar values
          live in Finance → Transactions, never here.
        </p>
      </div>

      {error && <Banner className="mx-4 sm:mx-6 my-2">{error}</Banner>}

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center"><p className="text-xs text-muted">Loading…</p></div>
      ) : accounts.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center px-6">
          <div>
            <p className="text-sm text-secondary">No balance-sheet accounts yet.</p>
            <p className="text-xs text-faint mt-1">Map the chart of accounts first, under Chart of Accounts.</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-4 sm:px-6 py-4">
          <div className="bg-surface border border-line rounded-lg overflow-hidden">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-line">
                  <th className="px-4 py-2 text-left text-muted font-medium">Account</th>
                  <th className="px-4 py-2 text-left text-muted font-medium">Sources</th>
                  <th className="px-4 py-2 text-left text-muted font-medium">Current Balance</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => {
                  const addableProviders = account.availableProviderKeys.filter(
                    (key) => !account.sources.some((s) => s.providerKey === key),
                  );
                  return (
                    <tr key={account.id} className="border-t border-line/40 align-top hover:bg-surface-mid/20">
                      <td className="px-4 py-3">
                        <span className="text-body">{accountLabel(account)}</span>
                      </td>

                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-2">
                          {account.sources.length === 0 && (
                            <span className="text-2xs text-faint italic">No source configured</span>
                          )}
                          {account.sources.map((source) => {
                            const key = `${account.id}:${source.providerKey}`;
                            return (
                              <div key={source.providerKey} className="flex items-center gap-2 flex-wrap">
                                <Badge tone={source.active ? "success" : "neutral"}>{providerLabel(source.providerKey)}</Badge>
                                {Object.keys(source.config).length > 0 && (
                                  <span className="text-2xs text-faint font-mono">{JSON.stringify(source.config)}</span>
                                )}
                                <button
                                  type="button"
                                  onClick={() => handleToggleActive(account, source)}
                                  disabled={savingKey === key}
                                  className="btn-secondary btn-xxs"
                                >
                                  {source.active ? "Disable" : "Enable"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleRemove(account, source)}
                                  disabled={savingKey === key}
                                  className="btn-danger btn-xxs"
                                >
                                  Remove
                                </button>
                                {source.providerKey === "manualBalance" && (
                                  <a href={MANUAL_ENTRIES_HREF} className="btn-secondary btn-xxs">
                                    Enter value in Manual Entries →
                                  </a>
                                )}
                                {savingKey === key && <span className="text-2xs text-faint animate-pulse">saving…</span>}
                              </div>
                            );
                          })}

                          {addableProviders.length > 0 && (
                            <div className="flex items-center gap-2">
                              <select
                                value={pendingProvider[account.id] ?? ""}
                                onChange={(e) => setPendingProvider((p) => ({ ...p, [account.id]: e.target.value }))}
                                className="inp-sm w-auto"
                              >
                                <option value="">— add a source —</option>
                                {addableProviders.map((key) => (
                                  <option key={key} value={key}>{providerLabel(key)}</option>
                                ))}
                              </select>
                              <button
                                type="button"
                                onClick={() => handleAdd(account)}
                                disabled={!pendingProvider[account.id]}
                                className="btn-primary btn-xxs"
                              >
                                Add
                              </button>
                            </div>
                          )}
                        </div>
                      </td>

                      <td className="px-4 py-3">
                        {account.currentBalance ? (
                          <div className="flex flex-col gap-0.5">
                            <span className="font-mono text-sm tabular-nums text-strong">
                              {formatCurrencyCents(account.currentBalance.cents)}
                            </span>
                            <span className="text-2xs text-faint">as of {account.currentBalance.periodEnd}</span>
                            {Object.entries(account.currentBalance.contributions).map(([providerKey, cents]) => (
                              <span key={providerKey} className="text-2xs text-muted">
                                {providerLabel(providerKey)}: {formatCurrencyCents(cents)}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-2xs text-faint">No snapshot yet</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <Card padding="p-3" className="mt-3">
            <p className="text-2xs text-faint">
              Current Balance is read-only, computed by the monthly snapshot job (or live for the current,
              still-open month) — it can never be edited here. To correct a manually-sourced account&apos;s balance,
              use <a href={MANUAL_ENTRIES_HREF} className="text-accent hover:text-accent-soft">Manual Entries</a>{" "}
              instead.
            </p>
          </Card>
        </div>
      )}
    </>
  );
}
