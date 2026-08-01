"use client";
// Ramp Connection settings screen: the setup half of the Ramp balance method.
//
// It does exactly one thing the shared plumbing cannot -- ask Ramp which
// treasury accounts exist and let an operator connect one. Everything after
// that is already built and is deliberately not duplicated here:
//
//   * Creating/removing the connection row is PUT/DELETE
//     /api/finance/balance-connections, the endpoint all three integrations
//     share.
//   * Attaching a connection to a GL account is the picker on Settings >
//     Balance Sheet Accounts. This screen links there rather than growing a
//     second way to do it, so there is one place an account gets its source.
//
// ── No credential is entered here ────────────────────────────────────────────
// Ramp authenticates with an app-level client id and secret held in env and
// shared with the expense sync under the P&L. There is nothing to type in and
// nothing to reconnect: connecting is purely choosing which account maps to
// which GL account. Plaid's screen will look different for exactly that reason.
//
// Gated on CAP.financeTransactionsManage via app/settings/finance/layout.tsx,
// same as every sibling page here. The route enforces it independently.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import { formatCurrencyCents } from "@/lib/format";
import Banner from "@/app/components/ui/Banner";
import Card from "@/app/components/ui/Card";
import Badge from "@/app/components/ui/Badge";

const BALANCE_ACCOUNTS_HREF = "/settings/finance/balance-sheet-accounts";

/** Outcome of a live read, shown inline against the account it was run for. */
interface CheckResult {
  ok: boolean;
  periodEnd: string;
  balanceCents?: number;
  reason?: string;
}

interface ConnectionRef {
  id: string;
  label: string;
  status: string;
}

interface RampAccount {
  id: string;
  name: string;
  accountType: string;
  /** Set when this Ramp account already has a connection row. */
  connection: ConnectionRef | null;
}

interface RampAccountsResponse {
  accounts: RampAccount[];
}

/** The label stored on the connection row, and what the GL picker shows. */
function connectionLabel(account: RampAccount): string {
  return `Ramp · ${account.name || account.accountType || "Account"}`;
}

export default function RampConnectionPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, CheckResult>>({});

  const { data, isLoading, error: loadError } = useQuery({
    queryKey: queryKeys.finance.rampAccounts(),
    queryFn: () => fetchJson<RampAccountsResponse>("/api/finance/balance-connections/ramp"),
    // Every load is a live call to Ramp, so don't re-fire it on window focus.
    refetchOnWindowFocus: false,
    retry: false,
  });

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.finance.rampAccounts() }),
      // The Balance Sheet Accounts screen renders the same connections in its
      // picker, so a connect here must not leave that page showing a stale list.
      queryClient.invalidateQueries({ queryKey: queryKeys.finance.balanceSources() }),
    ]);
  }

  /**
   * Reads one month end from Ramp for real and shows the result.
   *
   * Run automatically the moment an account is connected, because a connection
   * that has never been read proves nothing -- without this, the first real
   * call to Ramp would be the month-end snapshot, weeks away, where a missing
   * scope or a wrong account surfaces as a silently unsourced account during
   * close.
   */
  async function runCheck(accountId: string, connectionId: string) {
    try {
      const res = await fetch("/api/finance/balance-connections/ramp/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
      setChecks((c) => ({ ...c, [accountId]: body as CheckResult }));
    } catch (err) {
      setChecks((c) => ({
        ...c,
        [accountId]: {
          ok: false,
          periodEnd: "",
          reason: err instanceof Error ? err.message : "The check could not be run.",
        },
      }));
    }
  }

  async function handleConnect(account: RampAccount) {
    setBusyId(account.id);
    setError(null);
    try {
      const res = await fetch("/api/finance/balance-connections", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "ramp",
          label: connectionLabel(account),
          externalId: account.id,
        }),
      });
      const created = await res.json();
      if (!res.ok) throw new Error(created?.error ?? `Request failed (${res.status})`);
      // Prove the connection works before the operator walks away from it.
      await runCheck(account.id, created.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect that account.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleCheck(account: RampAccount) {
    if (!account.connection) return;
    setBusyId(account.id);
    setError(null);
    await runCheck(account.id, account.connection.id);
    await refresh();
    setBusyId(null);
  }

  async function handleDisconnect(account: RampAccount) {
    if (!account.connection) return;
    setBusyId(account.id);
    setError(null);
    try {
      const res = await fetch("/api/finance/balance-connections", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: account.connection.id }),
      });
      if (!res.ok) throw new Error((await res.json())?.error ?? `Request failed (${res.status})`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect that account.");
    } finally {
      setBusyId(null);
    }
  }

  const accounts = data?.accounts ?? [];
  const connectedCount = accounts.filter((a) => a.connection).length;

  return (
    <>
      <div className="shrink-0 px-4 sm:px-6 pt-4 pb-2">
        <p className="text-sm text-muted">
          {accounts.length > 0
            ? `${connectedCount} of ${accounts.length} Ramp accounts connected`
            : "Ramp accounts appear here once Ramp is reachable."}
        </p>
        <p className="text-2xs text-faint mt-1">
          Connecting an account only records which Ramp account it is. To make it drive a balance, choose{" "}
          <span className="text-secondary">Ramp account balance</span> on the matching account under{" "}
          <a href={BALANCE_ACCOUNTS_HREF} className="underline">Balance Sheet Accounts</a> and link it there.
        </p>
      </div>

      {error && <Banner className="mx-4 sm:mx-6 my-2">{error}</Banner>}
      {loadError && (
        <Banner className="mx-4 sm:mx-6 my-2">
          Could not reach Ramp: {loadError instanceof Error ? loadError.message : "unknown error"}
        </Banner>
      )}

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center"><p className="text-xs text-muted">Loading…</p></div>
      ) : accounts.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center px-6">
          <div>
            <p className="text-sm text-secondary">No Ramp accounts to show.</p>
            <p className="text-xs text-faint mt-1">
              Ramp returned no treasury accounts, or its credentials are not configured for this environment.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-4 sm:px-6 py-4 flex flex-col gap-3">
          <div className="bg-surface border border-line rounded-lg overflow-hidden">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-line">
                  <th className="px-4 py-2 text-left text-muted font-medium">Ramp account</th>
                  <th className="px-4 py-2 text-left text-muted font-medium">Status</th>
                  <th className="px-4 py-2 text-right text-muted font-medium" />
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => (
                  <tr key={account.id} className="border-t border-line/40 hover:bg-surface-mid/20">
                    <td className="px-4 py-3">
                      <span className="text-body">{account.name || "Unnamed account"}</span>
                      {account.accountType && (
                        <span className="text-2xs text-faint ml-2">{account.accountType}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {account.connection ? (
                        <Badge tone={account.connection.status === "active" ? "success" : "danger"}>
                          {account.connection.status.replace("_", " ")}
                        </Badge>
                      ) : (
                        <span className="text-2xs text-faint italic">Not connected</span>
                      )}
                      {checks[account.id] && (
                        <p className="text-2xs text-faint mt-1">
                          {checks[account.id].ok ? (
                            <>
                              Read {formatCurrencyCents(checks[account.id].balanceCents ?? 0)} for{" "}
                              {checks[account.id].periodEnd} — check this against Ramp.
                            </>
                          ) : (
                            <span className="text-danger">{checks[account.id].reason}</span>
                          )}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {account.connection ? (
                        <div className="flex gap-2 justify-end">
                          <button
                            type="button"
                            className="btn-secondary btn-xxs"
                            disabled={busyId === account.id}
                            onClick={() => handleCheck(account)}
                          >
                            {busyId === account.id ? "Checking…" : "Check now"}
                          </button>
                          <button
                            type="button"
                            className="btn-danger btn-xxs"
                            disabled={busyId === account.id}
                            onClick={() => handleDisconnect(account)}
                          >
                            Disconnect
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="btn-secondary btn-xxs"
                          disabled={busyId === account.id}
                          onClick={() => handleConnect(account)}
                        >
                          Connect
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Card padding="p-3">
            <p className="text-2xs text-faint leading-relaxed">
              Disconnecting removes the mapping only. Any balance already recorded for a past month stays as it was —
              the account simply stops producing new figures and reads as unsourced until it is connected again.
            </p>
          </Card>
        </div>
      )}
    </>
  );
}
