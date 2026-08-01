"use client";
/**
 * Bank Connections — the Plaid setup flow.
 *
 * Deliberately NOT part of Settings > Balance Sheet Accounts. That screen is
 * shared by every integration and attaches an EXISTING connection to a GL
 * account; creating one is each integration's own job, and three branches
 * editing one file would collide. See docs/finance/balance-methods-handoff.md
 * § 3b and § 3c2.
 *
 * The flow, and why it has three steps rather than one:
 *
 *   1. Ask the server for a Link token. The browser cannot mint one — that
 *      needs the app secret.
 *   2. Run Plaid Link. It hands back a public token: single-use, ~30 minutes,
 *      useless without the app secret.
 *   3. Post it to the exchange route, which swaps it for the long-lived
 *      credential SERVER-SIDE and stores it. The browser never sees that token.
 *
 * Then the operator chooses which account on the item feeds the GL, because an
 * item can carry several and picking the first would be silently wrong. That
 * choice goes through the shared connections route as `externalId`.
 *
 * ── OAuth banks ──────────────────────────────────────────────────────────────
 * Chase is an OAuth institution: Link navigates the whole page to the bank and
 * back to PLAID_REDIRECT_URI, so the React state that opened it is gone by the
 * time the operator returns. The token is stashed in sessionStorage before Link
 * opens and the session is resumed on mount when Plaid appends
 * `oauth_state_id`. Without that, a Chase link cannot complete at all.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import Banner from "@/app/components/ui/Banner";
import Badge from "@/app/components/ui/Badge";
import Card from "@/app/components/ui/Card";

const PLAID_LINK_SRC = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
const RESUME_KEY = "plaid-link-resume";
const BALANCE_ACCOUNTS_HREF = "/settings/finance/balance-sheet-accounts";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Connection {
  id: string;
  provider: string;
  label: string;
  externalId: string | null;
  config: Record<string, unknown>;
  status: "active" | "needs_reauth" | "disabled" | "error";
  lastSyncedAt: string | null;
  lastError: string | null;
}

interface PlaidAccountChoice {
  id: string;
  name: string;
  mask: string | null;
  type: string;
  subtype: string | null;
}

interface PlaidHandler {
  open: () => void;
  exit: () => void;
  destroy: () => void;
}

interface PlaidLinkGlobal {
  create(config: {
    token: string;
    receivedRedirectUri?: string;
    onSuccess: (publicToken: string) => void;
    onExit: (err: { display_message?: string; error_message?: string } | null) => void;
  }): PlaidHandler;
}

declare global {
  interface Window {
    Plaid?: PlaidLinkGlobal;
  }
}

/** What survives a full-page redirect to an OAuth bank and back. */
interface ResumeState {
  linkToken: string;
  /** Set when repairing an existing connection rather than creating one. */
  connectionId?: string;
  label: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

/** Loads Plaid's Link script once, resolving when window.Plaid is available. */
function loadPlaidScript(): Promise<PlaidLinkGlobal> {
  if (window.Plaid) return Promise.resolve(window.Plaid);

  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${PLAID_LINK_SRC}"]`);
    const script = existing ?? document.createElement("script");

    const done = () => (window.Plaid ? resolve(window.Plaid) : reject(new Error("Plaid Link failed to load.")));
    script.addEventListener("load", done, { once: true });
    script.addEventListener("error", () => reject(new Error("Plaid Link could not be reached.")), { once: true });

    if (!existing) {
      script.src = PLAID_LINK_SRC;
      script.async = true;
      document.head.appendChild(script);
    } else if (window.Plaid) {
      done();
    }
  });
}

function statusTone(status: Connection["status"]) {
  if (status === "active") return "success" as const;
  if (status === "needs_reauth") return "danger" as const;
  if (status === "error") return "danger" as const;
  return "neutral" as const;
}

function statusLabel(c: Connection): string {
  if (c.status === "active") return c.externalId ? "Connected" : "Account not chosen";
  if (c.status === "needs_reauth") return "Reconnect needed";
  if (c.status === "disabled") return "Turned off";
  return "Last read failed";
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function BankConnectionsPage() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** Set once an exchange succeeds and the operator must pick an account. */
  const [picking, setPicking] = useState<{ connectionId: string; accounts: PlaidAccountChoice[] } | null>(null);

  const handlerRef = useRef<PlaidHandler | null>(null);

  const { data, isLoading, error: loadError } = useQuery({
    queryKey: queryKeys.finance.balanceConnections(),
    queryFn: () => fetchJson<{ connections: Connection[] }>("/api/finance/balance-connections"),
  });

  const connections = (data?.connections ?? []).filter((c) => c.provider === "plaid");

  /**
   * `balanceSources` is invalidated alongside this screen's own list because
   * Balance Sheet Accounts renders the connection picker from a cache of its
   * own. Without this, a bank linked here does not appear there until that page
   * happens to refetch, which reads as the link having silently failed.
   */
  const refresh = useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.finance.balanceConnections() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.finance.balanceSources() }),
      ]),
    [queryClient],
  );

  /**
   * Swaps the public token for a stored credential and moves on to the account
   * choice. Shared by the fresh-link, repair and OAuth-resume paths so all
   * three end identically.
   */
  const completeLink = useCallback(
    async (publicToken: string, resume: ResumeState) => {
      setBusy(true);
      setError(null);
      try {
        const result = await postJson<{ connectionId: string; accounts: PlaidAccountChoice[] }>(
          "/api/finance/balance-connections/plaid/exchange",
          { publicToken, label: resume.label, id: resume.connectionId },
        );
        await refresh();
        const usable = result.accounts.filter((a) => a.type === "depository");
        if (usable.length === 0) {
          setError("That bank link has no deposit accounts on it. Balance-sheet cash must come from a bank account.");
        } else {
          setPicking({ connectionId: result.connectionId, accounts: usable });
          setNotice("Bank connected. Choose which account feeds the general ledger.");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not finish connecting that bank.");
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const openLink = useCallback(
    async (resume: ResumeState, receivedRedirectUri?: string) => {
      const Plaid = await loadPlaidScript();
      handlerRef.current?.destroy();
      handlerRef.current = Plaid.create({
        token: resume.linkToken,
        ...(receivedRedirectUri ? { receivedRedirectUri } : {}),
        onSuccess: (publicToken) => {
          sessionStorage.removeItem(RESUME_KEY);
          void completeLink(publicToken, resume);
        },
        onExit: (err) => {
          sessionStorage.removeItem(RESUME_KEY);
          setBusy(false);
          if (err) setError(err.display_message ?? err.error_message ?? "The bank connection was not completed.");
        },
      });
      handlerRef.current.open();
    },
    [completeLink],
  );

  /**
   * Resumes an OAuth link the bank redirected back from. Runs once on mount;
   * `oauth_state_id` in the query string is Plaid's own marker that this page
   * load is a return trip rather than a fresh visit.
   */
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("oauth_state_id")) return;

    void (async () => {
      const stored = sessionStorage.getItem(RESUME_KEY);
      if (!stored) {
        setError("That bank sign-in could not be resumed. Start the connection again.");
        return;
      }
      try {
        await openLink(JSON.parse(stored) as ResumeState, window.location.href);
      } catch {
        sessionStorage.removeItem(RESUME_KEY);
        setError("That bank sign-in could not be resumed. Start the connection again.");
      }
    })();
    // Mount-only: re-running would open a second Link over the first.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => handlerRef.current?.destroy(), []);

  async function startLink(connection?: Connection) {
    setBusy(true);
    setError(null);
    setNotice(null);
    setPicking(null);
    try {
      const { linkToken } = await postJson<{ linkToken: string }>("/api/finance/balance-connections/plaid/link-token", {
        id: connection?.id,
      });
      const resume: ResumeState = {
        linkToken,
        connectionId: connection?.id,
        label: connection?.label ?? "Chase · Operating",
      };
      // Written BEFORE opening, because an OAuth bank navigates this page away.
      sessionStorage.setItem(RESUME_KEY, JSON.stringify(resume));
      await openLink(resume);
    } catch (err) {
      sessionStorage.removeItem(RESUME_KEY);
      setBusy(false);
      setError(err instanceof Error ? err.message : "Could not start a bank connection.");
    }
  }

  async function chooseAccount(connectionId: string, account: PlaidAccountChoice) {
    setBusy(true);
    setError(null);
    try {
      const label = account.mask ? `${account.name} ····${account.mask}` : account.name;
      const res = await fetch("/api/finance/balance-connections", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: connectionId, provider: "plaid", label, externalId: account.id }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Could not save that account.");
      setPicking(null);
      setNotice("Account linked. Attach it to a GL account under Balance Sheet Accounts.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that account.");
    } finally {
      setBusy(false);
    }
  }

  async function removeConnection(connection: Connection) {
    if (!window.confirm(`Remove ${connection.label}? Captured balances are kept but stop being attributed to it.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/finance/balance-connections", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: connection.id }),
      });
      if (!res.ok) throw new Error("Could not remove that connection.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove that connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="shrink-0 px-4 sm:px-6 pt-4 pb-2">
        <p className="text-sm text-muted">
          Bank accounts read through Plaid. Connecting one here makes it selectable on{" "}
          <a href={BALANCE_ACCOUNTS_HREF} className="underline">Balance Sheet Accounts</a>, which is where it gets
          attached to a GL account.
        </p>
      </div>

      <div className="flex-1 overflow-auto px-4 sm:px-6 py-2 space-y-3">
        {error && <Banner>{error}</Banner>}
        {loadError && <Banner>Could not load connections. Reload to try again.</Banner>}
        {notice && <Banner tone="success">{notice}</Banner>}

        {isLoading ? (
          <p className="text-xs text-muted">Loading…</p>
        ) : (
          <>
            {connections.length === 0 && (
              <Card>
                <p className="text-sm text-secondary">No bank connected yet.</p>
                <p className="text-xs text-faint mt-1">
                  Connect Chase to feed GL 1020 Chase Operating. You will be asked to sign in at your bank; this app
                  never sees those details.
                </p>
              </Card>
            )}

            {connections.map((c) => (
              <Card key={c.id}>
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-body">{c.label}</span>
                      <Badge tone={statusTone(c.status)}>{statusLabel(c)}</Badge>
                    </div>
                    <p className="text-2xs text-faint mt-1">
                      {c.lastSyncedAt ? `Last read ${c.lastSyncedAt.slice(0, 10)}` : "Never read yet"}
                      {c.lastError ? ` · ${c.lastError}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <button className="text-xs text-accent hover:underline" disabled={busy} onClick={() => startLink(c)}>
                      {c.status === "needs_reauth" ? "Reconnect" : "Re-link"}
                    </button>
                    <button
                      className="text-xs text-danger hover:underline"
                      disabled={busy}
                      onClick={() => removeConnection(c)}
                    >
                      Remove
                    </button>
                  </div>
                </div>

                {picking?.connectionId === c.id && (
                  <div className="mt-3 border-t border-line/50 pt-3">
                    <p className="text-xs text-secondary mb-2">
                      Which account should feed the general ledger?
                    </p>
                    <div className="flex flex-col gap-1">
                      {picking.accounts.map((a) => (
                        <button
                          key={a.id}
                          disabled={busy}
                          onClick={() => chooseAccount(c.id, a)}
                          className="text-left text-xs text-body hover:bg-surface-mid/30 rounded px-2 py-1.5"
                        >
                          {a.name}
                          {a.mask ? ` ····${a.mask}` : ""}
                          <span className="text-faint"> · {a.subtype ?? a.type}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </Card>
            ))}

            <button className="btn-sm" disabled={busy} onClick={() => startLink()}>
              {busy ? "Working…" : "Connect a bank"}
            </button>

            <p className="text-2xs text-faint leading-relaxed max-w-prose">
              Your bank cannot be asked for a past balance, so the balance is read once a day and saved under that
              day&apos;s date. A month end with no reading stays blank on the balance sheet rather than borrowing a
              nearby day&apos;s figure. The daily read runs as the balance-capture job — its history is under
              Settings &gt; Environment &gt; Cron Jobs.
            </p>
          </>
        )}
      </div>
    </>
  );
}
