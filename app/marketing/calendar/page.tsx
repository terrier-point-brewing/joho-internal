import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
import { requirePage } from "@/lib/auth";
import { can } from "@/lib/auth/resolve";
import { CAP } from "@/lib/auth/capabilities";
import { listConnectedAccounts } from "@/lib/marketing/accounts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import MarketingNav from "../MarketingNav";
import CalendarTab from "../components/CalendarTab";

export const dynamic = "force-dynamic";

/**
 * The calendar surface. The page is the shell — frozen title and subtabs, and
 * nothing else in it (docs/UI_STANDARD.md §4) — and every affordance, including
 * Compose, lives in the scrollable content below via CalendarTab.
 *
 * Two things are resolved here rather than in the client component:
 *
 *   * **The connected logins.** `marketing_connected_accounts` is
 *     service-role-only with no policies, so a browser cannot read it at all.
 *     The server reads it through the credential-free column list and hands
 *     down the four harmless fields a screen needs.
 *   * **What this person may do.** requirePage returns the session, so the
 *     three capabilities are answered once, server-side, with the same `can()`
 *     the API routes use. A button nobody can press is never rendered.
 */
export default async function MarketingCalendarPage() {
  const session = await requirePage(CAP.marketingAccess);
  const accounts = await listConnectedAccounts(createSupabaseAdminClient());

  return (
    <main className="px-4 sm:px-6">
      <StickyHeader divider>
        <MarketingNav mobile />
        <PageHeader title="Calendar" description="One schedule for every marketing channel." />
      </StickyHeader>

      <div className="mt-4 pb-4 sm:pb-8">
        <CalendarTab
          accounts={accounts}
          canEdit={can(session.grants, CAP.marketingCalendarEdit.scope, CAP.marketingCalendarEdit.level)}
          canPublish={can(session.grants, CAP.marketingPublish.scope, CAP.marketingPublish.level)}
          canManageAccounts={can(
            session.grants,
            CAP.marketingAccountsManage.scope,
            CAP.marketingAccountsManage.level,
          )}
        />
      </div>
    </main>
  );
}
