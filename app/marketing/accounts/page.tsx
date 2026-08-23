import Card from "@/app/components/ui/Card";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
import MarketingNav from "../MarketingNav";
import { requirePage } from "@/lib/auth";
import { CAP } from "@/lib/auth/capabilities";

/**
 * Connected channel logins. Gated on CAP.marketingAccountsManage — exactly
 * what the Accounts nav entry requires — because this screen exists to hold
 * credentials, and the section's admission leaf must never carry that
 * authority.
 *
 * Deny goes back to Calendar: anyone reaching this page already cleared the
 * layout's `marketing.access` gate, so Calendar is provably reachable for them.
 */
export default async function MarketingAccountsPage() {
  await requirePage(CAP.marketingAccountsManage, "/marketing/calendar");

  return (
    <main className="px-4 sm:px-6">
      <StickyHeader divider>
        <MarketingNav mobile />
        <PageHeader
          title="Accounts"
          description="Channel logins the publisher posts through."
        />
      </StickyHeader>

      <div className="mt-4 pb-4 sm:pb-8">
        <Card>
          <p className="text-sm text-muted">No channels are connected.</p>
        </Card>
      </div>
    </main>
  );
}
