import Badge from "@/app/components/ui/Badge";
import Card from "@/app/components/ui/Card";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
import { requirePage } from "@/lib/auth";
import { CAP } from "@/lib/auth/capabilities";
import { listConnectedAccounts } from "@/lib/marketing/accounts";
import { listChannels } from "@/lib/marketing/plugins/registry";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import MarketingNav from "../MarketingNav";
import { ACCOUNT_STATUS_LABEL, ACCOUNT_STATUS_TONE, channelLabel } from "../components/status";

export const dynamic = "force-dynamic";

/**
 * Connected channel logins, read-only.
 *
 * The same rows the Settings → Marketing panel manages, with no controls on
 * them: connecting a login is a configuration act and this app keeps those in
 * one place. This screen exists so somebody working the calendar can see
 * whether a channel is live without holding the permission to change it.
 *
 * Gated on CAP.marketingAccountsManage — exactly what the Accounts nav entry
 * requires — because the row identifies a credential even though it never
 * carries one. Deny goes back to Calendar: anyone here already cleared the
 * layout's `marketing.access` gate, so Calendar is provably reachable.
 */
export default async function MarketingAccountsPage() {
  await requirePage(CAP.marketingAccountsManage, "/marketing/calendar");

  const accounts = await listConnectedAccounts(createSupabaseAdminClient());
  // Channels with a plugin but no row yet — a channel a person could connect
  // and has not. Production registers none, which is why the empty case below
  // is a sentence rather than a blank panel.
  const unconnected = listChannels()
    .map((p) => p.channel)
    .filter((channel) => !accounts.some((a) => a.channel === channel));

  return (
    <main className="px-4 sm:px-6">
      <StickyHeader divider>
        <MarketingNav mobile />
        <PageHeader title="Accounts" description="Channel logins the publisher posts through." />
      </StickyHeader>

      <div className="mt-4 pb-4 sm:pb-8">
        <Card padding="">
          {accounts.length === 0 && unconnected.length === 0 ? (
            <p className="text-sm text-muted p-4">
              No channel is set up in this app yet, so there is nothing to connect. When one arrives it will be
              connected in Settings → Marketing and listed here.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th className="px-3 py-2 text-left text-muted font-medium">Channel</th>
                  <th className="px-3 py-2 text-left text-muted font-medium">Status</th>
                  <th className="px-3 py-2 text-left text-muted font-medium">Handle</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => (
                  <tr key={account.id} className="border-b border-line last:border-0">
                    <td className="px-3 py-2 text-body">{channelLabel(account.channel)}</td>
                    <td className="px-3 py-2">
                      <Badge tone={ACCOUNT_STATUS_TONE[account.status] ?? "neutral"}>
                        {ACCOUNT_STATUS_LABEL[account.status] ?? account.status}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-secondary">{account.handle ?? "—"}</td>
                  </tr>
                ))}
                {unconnected.map((channel) => (
                  <tr key={channel} className="border-b border-line last:border-0">
                    <td className="px-3 py-2 text-body">{channelLabel(channel)}</td>
                    <td className="px-3 py-2">
                      <Badge>Not connected</Badge>
                    </td>
                    <td className="px-3 py-2 text-faint">—</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </main>
  );
}
