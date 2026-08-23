"use client";

/**
 * Connect, reconnect and disconnect one channel login.
 *
 * ── The list is the registry's, not this file's ─────────────────────────────
 * Every row here is a plugin the server has registered. This component names no
 * channel and has no fallback list, which is the point: adding Instagram later
 * is a folder and a registry line, and this screen grows a row on its own.
 *
 * **Production registers nothing**, so the ordinary first-run state of this
 * panel is zero rows — and that renders as a sentence saying so, not as a blank
 * card. See lib/marketing/plugins/registry.ts.
 *
 * ── Connect is a navigation, not a fetch ────────────────────────────────────
 * `GET /api/marketing/accounts/connect/[channel]` mints a CSRF state, drops it
 * in an httpOnly cookie and 302s to the provider. That has to happen in the
 * address bar — an XHR would follow the redirect into the provider's HTML and
 * leave the person looking at nothing.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";

import Badge from "@/app/components/ui/Badge";
import Banner from "@/app/components/ui/Banner";
import Card from "@/app/components/ui/Card";
import ConfirmDialog from "@/app/components/ui/ConfirmDialog";
import type { ConnectedAccountSummary } from "@/lib/marketing/accounts";
import { ACCOUNT_STATUS_LABEL, ACCOUNT_STATUS_TONE, channelLabel } from "@/app/marketing/components/status";

export interface RegisteredChannel {
  channel: string;
  provider: string;
}

export default function ConnectedAccountsPanel({
  channels,
  accounts,
}: {
  channels: RegisteredChannel[];
  accounts: ConnectedAccountSummary[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pendingDisconnect, setPendingDisconnect] = useState<ConnectedAccountSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const accountFor = (channel: string) => accounts.find((a) => a.channel === channel) ?? null;

  // A login whose plugin is no longer registered. It cannot be reconnected —
  // there is no code left that knows how — but it must still be visible and
  // disconnectable, because it may still be holding a live token.
  const orphaned = accounts.filter((a) => !channels.some((c) => c.channel === a.channel));

  async function disconnect(account: ConnectedAccountSummary) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/marketing/accounts/${account.id}/disconnect`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Request failed (${res.status})`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setPendingDisconnect(null);
    }
  }

  return (
    <div className="space-y-4">
      {error && <Banner tone="danger">{error}</Banner>}

      <Card padding="">
        {channels.length === 0 && orphaned.length === 0 ? (
          <p className="text-sm text-muted p-4">
            There is nothing to connect yet. This app publishes through channel plugins, and none is installed
            — when one arrives it appears here with a Connect button, and no setup is needed before then.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {channels.map(({ channel, provider }) => (
              <ChannelRow
                key={channel}
                channel={channel}
                provider={provider}
                account={accountFor(channel)}
                onDisconnect={setPendingDisconnect}
              />
            ))}
            {orphaned.map((account) => (
              <ChannelRow
                key={account.id}
                channel={account.channel}
                provider={account.provider}
                account={account}
                connectable={false}
                onDisconnect={setPendingDisconnect}
              />
            ))}
          </ul>
        )}
      </Card>

      {pendingDisconnect && (
        <ConfirmDialog
          title="Disconnect this login?"
          message={
            <>
              The row stays — a post that went out through {channelLabel(pendingDisconnect.channel)} keeps
              saying so — but its credential is emptied, and nothing can publish to this channel until it is
              connected again.
            </>
          }
          confirmLabel="Disconnect"
          busy={busy}
          onConfirm={() => void disconnect(pendingDisconnect)}
          onCancel={() => setPendingDisconnect(null)}
        />
      )}
    </div>
  );
}

function ChannelRow({
  channel,
  provider,
  account,
  connectable = true,
  onDisconnect,
}: {
  channel: string;
  provider: string;
  account: ConnectedAccountSummary | null;
  /** False for a login whose plugin is gone: there is no code left to reconnect through. */
  connectable?: boolean;
  onDisconnect: (account: ConnectedAccountSummary) => void;
}) {
  const live = account?.status === "connected";
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm text-body">{channelLabel(channel)}</span>
          <Badge tone={account ? (ACCOUNT_STATUS_TONE[account.status] ?? "neutral") : "neutral"}>
            {account ? (ACCOUNT_STATUS_LABEL[account.status] ?? account.status) : "Not connected"}
          </Badge>
        </div>
        <p className="text-xs text-muted mt-1 truncate">
          {provider}
          {account?.handle ? ` · ${account.handle}` : ""}
          {!connectable ? " · no plugin installed for this channel any more" : ""}
        </p>
        {account?.lastError && <p className="text-xs text-danger mt-1">{account.lastError}</p>}
      </div>

      <div className="flex gap-2">
        {account && (
          <button type="button" className="btn-danger" onClick={() => onDisconnect(account)}>
            Disconnect
          </button>
        )}
        {connectable && (
          <a className="btn-primary" href={`/api/marketing/accounts/connect/${encodeURIComponent(channel)}`}>
            {live ? "Reconnect" : "Connect"}
          </a>
        )}
      </div>
    </li>
  );
}
