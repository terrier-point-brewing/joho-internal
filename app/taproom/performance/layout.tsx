import { requirePage, CAP } from "@/lib/auth";
import SubNav from "@/app/components/SubNav";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
import { TAPROOM_NAV, PERFORMANCE_NAV } from "@/app/taproom/nav-config";

export default async function PerformanceLayout({ children }: { children: React.ReactNode }) {
  await requirePage(CAP.taproomPerformanceRead);
  return (
    <main className="px-4 sm:px-6">
      <StickyHeader>
        <SubNav entries={TAPROOM_NAV} mobile />
        <PageHeader title="Performance" description="Sales trends, draft throughput, and event summaries" />
        <SubNav entries={PERFORMANCE_NAV} />
      </StickyHeader>
      <div className="mt-4 pb-4 sm:pb-8">{children}</div>
    </main>
  );
}
