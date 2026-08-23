import Card from "@/app/components/ui/Card";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
import MarketingNav from "../MarketingNav";

/**
 * The calendar surface. Gated by the section layout on CAP.marketingAccess,
 * which is exactly what the Calendar nav entry requires — so the tab and the
 * page can never disagree.
 *
 * Empty by design: the calendar grid, entries and compose all arrive in later
 * chips. What ships here is the door and the shell.
 */
export default function MarketingCalendarPage() {
  return (
    <main className="px-4 sm:px-6">
      <StickyHeader divider>
        <MarketingNav mobile />
        <PageHeader
          title="Calendar"
          description="One schedule for every marketing channel."
        />
      </StickyHeader>

      <div className="mt-4 pb-4 sm:pb-8">
        <Card>
          <p className="text-sm text-muted">
            Scheduled posts appear here once a channel is connected.
          </p>
        </Card>
      </div>
    </main>
  );
}
