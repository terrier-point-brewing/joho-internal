import SettingsHeader from "@/app/settings/SettingsHeader";
import { listConnectedAccounts } from "@/lib/marketing/accounts";
import { listChannels } from "@/lib/marketing/plugins/registry";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import ConnectedAccountsPanel from "./ConnectedAccountsPanel";

export const dynamic = "force-dynamic";

/**
 * Group chrome (sidebar nav + mobile group row) comes from the settings group
 * shell, so the page is its header plus the panel.
 *
 * Both reads happen here, on the server, and for two different reasons:
 * `marketing_connected_accounts` has RLS on with no policies at all, so a
 * browser cannot read it however hard it tries; and the plugin registry
 * registers the fake only outside production, so what it lists is a fact about
 * the server this is running on.
 */
export default async function MarketingSettingsPage() {
  const accounts = await listConnectedAccounts(createSupabaseAdminClient());
  const channels = listChannels().map((plugin) => ({ channel: plugin.channel, provider: plugin.provider }));

  return (
    <div className="px-4 sm:px-6">
      <SettingsHeader
        title="Connected accounts"
        description="The channel logins the marketing publisher posts through."
      />
      <div className="pb-4 sm:pb-6">
        <ConnectedAccountsPanel channels={channels} accounts={accounts} />
      </div>
    </div>
  );
}
