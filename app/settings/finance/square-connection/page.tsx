"use client";
// Square Connection settings screen: the setup half of the Square balance method.
//
// Sibling of Ramp Connection, and deliberately shaped differently, because the
// two integrations need different things from an operator:
//
//   * Ramp's setup is a CHOICE -- list treasury accounts, connect one. Ramp
//     reports its own closing balance, so once connected there is nothing more
//     to supply.
//   * Square's setup is a STARTING POINT. There is nothing to choose (the
//     stored balance is merchant-wide, one per business), but Square publishes
//     no balance at all, so the derivation cannot begin without a figure a
//     person has read off Square and typed in.
//
// Everything the shared plumbing already does is not duplicated here:
//   * Creating/removing the connection row is PUT/DELETE
//     /api/finance/balance-connections, the endpoint all three integrations use.
//   * Attaching a connection to a GL account is the picker on Settings >
//     Balance Sheet Accounts, so there stays one place an account gets a source.
//
// ── Why the anchor is editable here AND on Manual Entries ────────────────────
// It is the same row either way -- one balance per account per month end, the
// exact thing Manual Entries writes. This screen is not a second store, it is a
// shortcut that shows the anchor in the context that explains what it is for.
// The monthly re-anchor can be done from either place.
//
// ── No credential is entered here ────────────────────────────────────────────
// Square authenticates with one business-wide token from env, shared with every
// other Square reader in the app. There is nothing to type in, and no reconnect.
//
// Gated on CAP.financeTransactionsManage via app/settings/finance/layout.tsx,
// same as every sibling page. Both routes enforce it independently.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import { formatCurrencyCents } from "@/lib/format";
import { formatAmountInput, parseAmountInputCents } from "@/lib/finance/manualEntryAmount";
import { monthEnd } from "@/lib/finance/manualEntries";
import Banner from "@/app/components/ui/Banner";
import Card from "@/app/components/ui/Card";
import Badge from "@/app/components/ui/Badge";

const BALANCE_ACCOUNTS_HREF = "/settings/finance/balance-sheet-accounts";

interface SquareConnection {
  id: string;
  label: string;
  status: string;
  externalId: string | null;
  lastSyncedAt: string | null;
}

interface SquareLocation {
  id: string;
  name: string;
}

interface SquareAccount {
  coaId: string;
  accountNumber: string | null;
  accountName: string;
  connectionId: string | null;
  anchor: { asOfDate: string; cents: number } | null;
}

interface SquareSetupResponse {
  locations: SquareLocation[];
  connections: SquareConnection[];
  accounts: SquareAccount[];
}

/** Trailing part of a "Parent:Child" COA name — what a bookkeeper actually calls it. */
function shortName(accountName: string): string {
  const parts = accountName.split(":");
  return parts[parts.length - 1].trim();
}

export default function SquareConnectionPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Anchor entry state, keyed by account so two accounts cannot share a draft.
  const [anchorDraft, setAnchorDraft] = useState<Record<string, { date: string; amount: string }>>({});

  const { data, isLoading, error: loadError } = useQuery({
    queryKey: queryKeys.finance.squareConnection(),
    queryFn: () => fetchJson<SquareSetupResponse>("/api/finance/balance-connections/square"),
    // Every load is a live call to Square, so don't re-fire it on window focus.
    refetchOnWindowFocus: false,
    retry: false,
  });

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.finance.squareConnection() }),
      // The Balance Sheet Accounts screen renders the same connections in its
      // picker, so a connect here must not leave that page showing a stale list.
      queryClient.invalidateQueries({ queryKey: queryKeys.finance.balanceSources() }),
    ]);
  }

  async function post(url: string, method: string, body: unknown) {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json())?.error ?? `Request failed (${res.status})`);
  }

  async function handleConnect(location: SquareLocation | null) {
    setBusy(true);
    setError(null);
    try {
      await post("/api/finance/balance-connections", "PUT", {
        provider: "square",
        label: location ? `Square · ${location.name}` : "Square · Deposit balance",
        externalId: location?.id ?? null,
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect Square.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect(connection: SquareConnection) {
    setBusy(true);
    setError(null);
    try {
      await post("/api/finance/balance-connections", "DELETE", { id: connection.id });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect Square.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveAnchor(account: SquareAccount) {
    const draft = anchorDraft[account.coaId];
    if (!draft) return;

    const amountCents = parseAmountInputCents(draft.amount);
    if (amountCents === null) {
      setError("Enter the balance as a number, for example 11041.75.");
      return;
    }
    if (!draft.date) {
      setError("Choose the month end this balance is for.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      // Snap to a month end. A balance dated mid-month would never be found by
      // the month-end close, and would silently anchor nothing.
      await post("/api/finance/balance-connections/square", "POST", {
        chartOfAccountsId: account.coaId,
        asOfDate: monthEnd(draft.date),
        amountCents,
      });
      setAnchorDraft((d) => {
        const next = { ...d };
        delete next[account.coaId];
        return next;
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that balance.");
    } finally {
      setBusy(false);
    }
  }

  const connections = data?.connections ?? [];
  const locations = data?.locations ?? [];
  const accounts = data?.accounts ?? [];
  const connected = connections.length > 0;

  return (
    <>
      <div className="shrink-0 px-4 sm:px-6 pt-4 pb-2">
        <p className="text-sm text-muted">
          {connected ? "Square is connected." : "Square is not connected yet."}
        </p>
        <p className="text-2xs text-faint mt-1">
          Square publishes no running balance, so this account is worked out from a figure you check and enter, plus
          everything Square has settled in since. Connect Square, enter an opening balance, then choose{" "}
          <span className="text-secondary">Square balance</span> on the matching account under{" "}
          <a href={BALANCE_ACCOUNTS_HREF} className="underline">Balance Sheet Accounts</a>.
        </p>
      </div>

      {error && <Banner className="mx-4 sm:mx-6 my-2">{error}</Banner>}
      {loadError && (
        <Banner className="mx-4 sm:mx-6 my-2">
          Could not reach Square: {loadError instanceof Error ? loadError.message : "unknown error"}
        </Banner>
      )}

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center"><p className="text-xs text-muted">Loading…</p></div>
      ) : (
        <div className="flex-1 overflow-auto px-4 sm:px-6 py-4 flex flex-col gap-4">
          {/* ── Step 1: the connection ─────────────────────────────────── */}
          <div>
            <h2 className="text-xs font-medium text-secondary mb-2">1. Connect Square</h2>
            <div className="bg-surface border border-line rounded-lg overflow-hidden">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b border-line">
                    <th className="px-4 py-2 text-left text-muted font-medium">Square account</th>
                    <th className="px-4 py-2 text-left text-muted font-medium">Status</th>
                    <th className="px-4 py-2 text-right text-muted font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {connected ? (
                    connections.map((connection) => (
                      <tr key={connection.id} className="border-t border-line/40">
                        <td className="px-4 py-3 text-body">{connection.label}</td>
                        <td className="px-4 py-3">
                          <Badge tone={connection.status === "active" ? "success" : "danger"}>
                            {connection.status.replace("_", " ")}
                          </Badge>
                          {connection.lastSyncedAt && (
                            <span className="text-2xs text-faint ml-2">
                              last read {connection.lastSyncedAt.slice(0, 10)}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            className="btn-danger btn-xxs"
                            disabled={busy}
                            onClick={() => handleDisconnect(connection)}
                          >
                            Disconnect
                          </button>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr className="border-t border-line/40">
                      <td className="px-4 py-3 text-body">
                        {locations[0]?.name ?? "Square"}
                        <span className="text-2xs text-faint ml-2">
                          the balance Square holds for your business
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-2xs text-faint italic">Not connected</span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          className="btn-secondary btn-xxs"
                          disabled={busy}
                          onClick={() => handleConnect(locations[0] ?? null)}
                        >
                          Connect
                        </button>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Step 2: the opening balance ────────────────────────────── */}
          <div>
            <h2 className="text-xs font-medium text-secondary mb-2">2. Enter the balance you checked</h2>
            {accounts.length === 0 ? (
              <Card padding="p-3">
                <p className="text-2xs text-faint leading-relaxed">
                  No account uses the Square balance yet. Choose{" "}
                  <span className="text-secondary">Square balance</span> on the Square Deposit account under{" "}
                  <a href={BALANCE_ACCOUNTS_HREF} className="underline">Balance Sheet Accounts</a>, then come back here
                  to enter the opening figure.
                </p>
              </Card>
            ) : (
              <div className="bg-surface border border-line rounded-lg overflow-hidden">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-line">
                      <th className="px-4 py-2 text-left text-muted font-medium">Account</th>
                      <th className="px-4 py-2 text-left text-muted font-medium">Last checked balance</th>
                      <th className="px-4 py-2 text-left text-muted font-medium">Month end</th>
                      <th className="px-4 py-2 text-left text-muted font-medium">Balance</th>
                      <th className="px-4 py-2 text-right text-muted font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((account) => {
                      const draft = anchorDraft[account.coaId] ?? { date: "", amount: "" };
                      return (
                        <tr key={account.coaId} className="border-t border-line/40">
                          <td className="px-4 py-3">
                            <span className="text-body">{shortName(account.accountName)}</span>
                            {account.accountNumber && (
                              <span className="text-2xs text-faint ml-2">{account.accountNumber}</span>
                            )}
                            {!account.connectionId && (
                              <span className="text-2xs text-accent ml-2">not linked to a connection</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {account.anchor ? (
                              <span className="font-mono tabular-nums text-strong">
                                {formatCurrencyCents(account.anchor.cents)}
                                <span className="text-2xs text-faint ml-2 font-sans">
                                  at {account.anchor.asOfDate}
                                </span>
                              </span>
                            ) : (
                              <span className="text-2xs text-faint italic">None yet</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <div className="w-36">
                              <input
                                type="date"
                                className="inp-sm"
                                value={draft.date}
                                onChange={(e) =>
                                  setAnchorDraft((d) => ({ ...d, [account.coaId]: { ...draft, date: e.target.value } }))
                                }
                              />
                              {/* Mirrors the same hint on Manual Entries: say so when
                                  the typed date is not the month end it will become. */}
                              {draft.date && monthEnd(draft.date) !== draft.date && (
                                <p className="text-2xs text-accent mt-1">saved as {monthEnd(draft.date)}</p>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="w-28">
                              <input
                                type="text"
                                inputMode="decimal"
                                placeholder="0.00"
                                className="inp-sm text-right font-mono tabular-nums"
                                value={draft.amount}
                                onChange={(e) =>
                                  setAnchorDraft((d) => ({
                                    ...d,
                                    [account.coaId]: { ...draft, amount: formatAmountInput(e.target.value) },
                                  }))
                                }
                              />
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button
                              type="button"
                              className="btn-secondary btn-xxs"
                              disabled={busy || !draft.date || !draft.amount}
                              onClick={() => handleSaveAnchor(account)}
                            >
                              Save
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <Card padding="p-3">
            <p className="text-2xs text-faint leading-relaxed">
              Do this again at every month end. Open Square, read the real balance, and enter it here for that month
              end — it becomes the new starting point, so any difference is corrected rather than carried forward.
              Expect a sizeable difference each month: money you move from Square to your bank is not reported by
              Square anywhere, so checking the figure is what accounts for it. The date is snapped to the end of
              whichever month you pick.
            </p>
          </Card>
        </div>
      )}
    </>
  );
}
