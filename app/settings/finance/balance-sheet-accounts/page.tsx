"use client";
// Balance Sheet Accounts settings screen: declares which METHOD
// (lib/finance/balances/methods/registry.ts) computes each balance-sheet
// account's monthly balance. RULES ONLY -- no editable dollar value exists
// anywhere on this screen. The "Current Balance" column is read-only, broken
// out per step via gl_account_balances.contributions, so a balance is
// explainable without leaving the page. A manual-entry account deep-links to
// Finance > Transactions > Manual Entries instead of an inline dollar input:
// Settings holds rules, Transactions holds values.
//
// ── Methods, not raw calculations ────────────────────────────────────────────
// The selector offers three things -- manual entry, transaction postings, or a
// named calculation -- and a calculation is always COMPLETE. An accrual and the
// postings that settle it are one choice, never two, because picking the
// accrual alone produces a wrong balance silently. GL 2310 shipped in exactly
// that state and read eight times its true liability.
//
// ── The explainer panel ──────────────────────────────────────────────────────
// Every method can be opened before it is chosen, showing its steps in plain
// English against this account's own figures. The copy is not written here: it
// comes from the method declaration the engine actually runs, so the two cannot
// drift apart. Nothing on this screen restates what a calculation does.
//
// Gated on CAP.financeTransactionsManage via app/settings/finance/layout.tsx
// (the whole /settings/finance/* group), same as every sibling page here.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import { formatCurrencyCents } from "@/lib/format";
import Banner from "@/app/components/ui/Banner";
import Card from "@/app/components/ui/Card";
import Badge from "@/app/components/ui/Badge";
import { Modal } from "@/app/components/ui/Modal";

type MethodKind = "manual" | "postings" | "calculation";

interface StepMeta {
  key: string;
  label: string;
  description: string;
  source: string;
  direction: "add" | "subtract" | "net";
}

interface MethodMeta {
  key: string;
  label: string;
  kind: MethodKind;
  summary: string;
  /** Set when the method reads an external service; drives the connection picker. */
  connectionProvider: "ramp" | "plaid" | "square" | null;
  steps: StepMeta[];
}

/** A configured external account, as offered in the picker. No secrets. */
interface ConnectionOption {
  id: string;
  provider: string;
  label: string;
  status: string;
}

interface ConnectionMeta {
  connected: boolean;
  label: string;
  lastSyncedAt?: string | null;
  remedy?: string;
}

interface SourceEntry {
  methodKey: string;
  config: Record<string, unknown>;
  active: boolean;
  updatedAt: string;
  connection: ConnectionMeta | null;
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
  availableMethodKeys: string[];
  currentBalance: CurrentBalance | null;
}

interface BalanceSourcesResponse {
  accounts: AccountRow[];
  methods: MethodMeta[];
  connections: ConnectionOption[];
}

const MANUAL_ENTRIES_HREF = "/finance/transactions/manual-entries";

const KIND_LABEL: Record<MethodKind, string> = {
  manual: "Manual entry",
  postings: "Transaction postings",
  calculation: "Calculation",
};

const DIRECTION_PREFIX: Record<StepMeta["direction"], string> = {
  add: "+",
  subtract: "−",
  net: "±",
};

async function putSource(
  coaId: string,
  providerKey: string,
  patch: { active?: boolean; config?: Record<string, unknown> } = {},
) {
  const res = await fetch("/api/finance/balance-sources", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ coaId, providerKey, ...patch }),
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

/**
 * "How is this calculated?" -- the method's declared steps, shown against this
 * account's real contributions where a snapshot exists so the arithmetic is
 * checkable rather than abstract.
 */
function MethodExplainer({
  method,
  account,
  onClose,
}: {
  method: MethodMeta;
  account: AccountRow | null;
  onClose: () => void;
}) {
  const contributions = account?.currentBalance?.contributions ?? {};
  const hasFigures = Object.keys(contributions).length > 0;

  return (
    <Modal title={method.label} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div>
          {account && <p className="text-2xs text-faint mb-1">{accountLabel(account)}</p>}
          <p className="text-sm text-secondary">{method.summary}</p>
        </div>

        <div className="flex flex-col gap-3">
          {method.steps.map((step, i) => (
            <div key={step.key} className="flex items-start gap-3">
              <span className="shrink-0 w-5 h-5 rounded-full bg-surface-mid text-2xs text-muted flex items-center justify-center">
                {i + 1}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-body">{step.label}</p>
                <p className="text-2xs text-faint mt-0.5 leading-relaxed">{step.description}</p>
                <p className="text-2xs text-muted mt-0.5">Source: {step.source}</p>
              </div>
              {hasFigures && (
                <span className="shrink-0 font-mono text-xs tabular-nums text-body">
                  {contributions[step.key] === undefined
                    ? "—"
                    : `${DIRECTION_PREFIX[step.direction]} ${formatCurrencyCents(Math.abs(contributions[step.key]))}`}
                </span>
              )}
            </div>
          ))}
        </div>

        {hasFigures && account?.currentBalance && (
          <div className="flex items-center justify-between border-t border-line pt-3">
            <span className="text-xs text-body">Balance at {account.currentBalance.periodEnd}</span>
            <span className="font-mono text-sm tabular-nums text-strong">
              {formatCurrencyCents(account.currentBalance.cents)}
            </span>
          </div>
        )}

        {method.steps.length > 1 && (
          <Card padding="p-3">
            <p className="text-2xs text-faint leading-relaxed">
              These steps always run together and cannot be enabled separately. Running only the first would report
              what has built up without ever subtracting what has been settled.
            </p>
          </Card>
        )}

        {!hasFigures && (
          <p className="text-2xs text-faint">
            No snapshot for this account yet, so there are no figures to show against the steps.
          </p>
        )}
      </div>
    </Modal>
  );
}

/**
 * Links a source to one of the configured external accounts, writing the choice
 * to `config.connectionId`.
 *
 * This lives in the shared Settings screen rather than in each integration
 * because all three need it identically, and three branches editing this file
 * would collide. Creating a connection is still each integration's own job --
 * picking a Ramp treasury account, running Plaid Link, entering a Square
 * anchor. This only attaches an existing one to a GL account.
 */
function ConnectionPicker({
  options,
  value,
  disabled,
  onChange,
}: {
  options: ConnectionOption[];
  value: string;
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  if (options.length === 0) {
    return (
      <span className="text-2xs text-faint">
        No account connected for this integration yet — set one up first.
      </span>
    );
  }
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="inp-sm w-auto"
    >
      <option value="">— link an account —</option>
      {options.map((c) => (
        <option key={c.id} value={c.id}>
          {c.label}
          {c.status === "active" ? "" : ` (${c.status.replace("_", " ")})`}
        </option>
      ))}
    </select>
  );
}

/** Connection state for an integration-backed source, or nothing for the rest. */
function ConnectionLine({ connection }: { connection: ConnectionMeta }) {
  return (
    <span className="text-2xs text-faint">
      {connection.label}
      {connection.connected && connection.lastSyncedAt
        ? ` · synced ${connection.lastSyncedAt.slice(0, 10)}`
        : connection.remedy
          ? ` · ${connection.remedy}`
          : ""}
    </span>
  );
}

export default function BalanceSheetAccountsPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [pendingKind, setPendingKind] = useState<Record<string, MethodKind | "">>({});
  const [pendingMethod, setPendingMethod] = useState<Record<string, string>>({});
  const [explaining, setExplaining] = useState<{ methodKey: string; accountId: string | null } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.finance.balanceSources(),
    queryFn: () => fetchJson<BalanceSourcesResponse>("/api/finance/balance-sources"),
  });

  const methods = data?.methods ?? [];
  const methodOf = (key: string) => methods.find((m) => m.key === key);
  const methodLabel = (key: string) => methodOf(key)?.label ?? key;

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: queryKeys.finance.balanceSources() });
  }

  /** Resolves what the two selects currently amount to, or null when incomplete. */
  function chosenMethodKey(account: AccountRow): string | null {
    const kind = pendingKind[account.id];
    if (!kind) return null;
    if (kind === "calculation") return pendingMethod[account.id] || null;
    // Manual and postings each have exactly one method, so the kind IS the choice.
    const match = methods.find((m) => m.kind === kind && account.availableMethodKeys.includes(m.key));
    return match?.key ?? null;
  }

  async function handleAdd(account: AccountRow) {
    const methodKey = chosenMethodKey(account);
    if (!methodKey) return;
    setSavingKey(`${account.id}:${methodKey}`);
    setError(null);
    try {
      await putSource(account.id, methodKey);
      setPendingKind((p) => ({ ...p, [account.id]: "" }));
      setPendingMethod((p) => ({ ...p, [account.id]: "" }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add that source.");
    } finally {
      setSavingKey(null);
    }
  }

  async function handleToggleActive(account: AccountRow, source: SourceEntry) {
    const key = `${account.id}:${source.methodKey}`;
    setSavingKey(key);
    setError(null);
    try {
      await putSource(account.id, source.methodKey, { active: !source.active });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update that source.");
    } finally {
      setSavingKey(null);
    }
  }

  async function handleLinkConnection(account: AccountRow, source: SourceEntry, connectionId: string) {
    const key = `${account.id}:${source.methodKey}`;
    setSavingKey(key);
    setError(null);
    try {
      // Merge rather than replace: the route stores config wholesale, so
      // dropping the rest of it here would quietly discard provider settings a
      // future integration keeps alongside connectionId.
      await putSource(account.id, source.methodKey, {
        config: { ...source.config, connectionId: connectionId || undefined },
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not link that account.");
    } finally {
      setSavingKey(null);
    }
  }

  async function handleRemove(account: AccountRow, source: SourceEntry) {
    const key = `${account.id}:${source.methodKey}`;
    setSavingKey(key);
    setError(null);
    try {
      await deleteSource(account.id, source.methodKey);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove that source.");
    } finally {
      setSavingKey(null);
    }
  }

  const accounts = data?.accounts ?? [];
  const sourcedCount = accounts.filter((a) => a.sources.some((s) => s.active)).length;
  const explainingMethod = explaining ? methodOf(explaining.methodKey) : undefined;
  const explainingAccount = explaining?.accountId
    ? (accounts.find((a) => a.id === explaining.accountId) ?? null)
    : null;

  return (
    <>
      <div className="shrink-0 px-4 sm:px-6 pt-4 pb-2">
        <p className="text-sm text-muted">
          {accounts.length > 0
            ? `${sourcedCount} of ${accounts.length} balance-sheet accounts have an active source`
            : "Balance-sheet accounts appear here once the chart of accounts is mapped."}
        </p>
        <p className="text-2xs text-faint mt-1">
          Rules only — declares how each account&apos;s monthly balance is worked out. Open any method to see its
          steps in plain English before choosing it. Dollar values live in Finance → Transactions, never here.
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
                  <th className="px-4 py-2 text-left text-muted font-medium">How it is calculated</th>
                  <th className="px-4 py-2 text-left text-muted font-medium">Current Balance</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => {
                  const addable = account.availableMethodKeys.filter(
                    (key) => !account.sources.some((s) => s.methodKey === key),
                  );
                  const addableKinds: MethodKind[] = (["manual", "postings", "calculation"] as MethodKind[]).filter(
                    (kind) => addable.some((key) => methodOf(key)?.kind === kind),
                  );
                  const kind = pendingKind[account.id] ?? "";
                  const chosen = chosenMethodKey(account);

                  return (
                    <tr key={account.id} className="border-t border-line/40 align-top hover:bg-surface-mid/20">
                      <td className="px-4 py-3">
                        <span className="text-body">{accountLabel(account)}</span>
                      </td>

                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-2">
                          {account.sources.length === 0 && (
                            <span className="text-2xs text-faint italic">No method configured</span>
                          )}
                          {account.sources.map((source) => {
                            const key = `${account.id}:${source.methodKey}`;
                            return (
                              <div key={source.methodKey} className="flex flex-col gap-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <Badge tone={source.active ? "success" : "neutral"}>
                                    {methodLabel(source.methodKey)}
                                  </Badge>
                                  {methodOf(source.methodKey) && (
                                    <button
                                      type="button"
                                      onClick={() => setExplaining({ methodKey: source.methodKey, accountId: account.id })}
                                      className="btn-secondary btn-xxs"
                                    >
                                      How is this calculated?
                                    </button>
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
                                  {source.methodKey === "manualBalance" && (
                                    <a href={MANUAL_ENTRIES_HREF} className="btn-secondary btn-xxs">
                                      Enter value in Manual Entries →
                                    </a>
                                  )}
                                  {savingKey === key && (
                                    <span className="text-2xs text-faint animate-pulse">saving…</span>
                                  )}
                                </div>
                                {source.connection && (
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <ConnectionPicker
                                      options={(data?.connections ?? []).filter(
                                        (c) => c.provider === methodOf(source.methodKey)?.connectionProvider,
                                      )}
                                      value={
                                        typeof source.config.connectionId === "string"
                                          ? source.config.connectionId
                                          : ""
                                      }
                                      disabled={savingKey === key}
                                      onChange={(id) => handleLinkConnection(account, source, id)}
                                    />
                                    <ConnectionLine connection={source.connection} />
                                  </div>
                                )}
                              </div>
                            );
                          })}

                          {addableKinds.length > 0 && (
                            <div className="flex items-center gap-2 flex-wrap">
                              <select
                                value={kind}
                                onChange={(e) => {
                                  setPendingKind((p) => ({ ...p, [account.id]: e.target.value as MethodKind | "" }));
                                  setPendingMethod((p) => ({ ...p, [account.id]: "" }));
                                }}
                                className="inp-sm w-auto"
                              >
                                <option value="">— add a method —</option>
                                {addableKinds.map((k) => (
                                  <option key={k} value={k}>{KIND_LABEL[k]}</option>
                                ))}
                              </select>

                              {kind === "calculation" && (
                                <select
                                  value={pendingMethod[account.id] ?? ""}
                                  onChange={(e) =>
                                    setPendingMethod((p) => ({ ...p, [account.id]: e.target.value }))
                                  }
                                  className="inp-sm w-auto"
                                >
                                  <option value="">— which calculation —</option>
                                  {addable
                                    .filter((key) => methodOf(key)?.kind === "calculation")
                                    .map((key) => (
                                      <option key={key} value={key}>{methodLabel(key)}</option>
                                    ))}
                                </select>
                              )}

                              {chosen && (
                                <button
                                  type="button"
                                  onClick={() => setExplaining({ methodKey: chosen, accountId: account.id })}
                                  className="btn-secondary btn-xxs"
                                >
                                  Preview
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => handleAdd(account)}
                                disabled={!chosen}
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
                            {Object.entries(account.currentBalance.contributions).map(([stepKey, cents]) => (
                              <span key={stepKey} className="text-2xs text-muted">
                                {stepKey}: {formatCurrencyCents(cents)}
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
              still-open month) — it can never be edited here. To correct a manually-entered account&apos;s balance,
              use <a href={MANUAL_ENTRIES_HREF} className="text-accent hover:text-accent-soft">Manual Entries</a>{" "}
              instead.
            </p>
          </Card>
        </div>
      )}

      {explaining && explainingMethod && (
        <MethodExplainer
          method={explainingMethod}
          account={explainingAccount}
          onClose={() => setExplaining(null)}
        />
      )}
    </>
  );
}
