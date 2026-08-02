import { requirePage, CAP } from "@/lib/auth";
import SubNav from "@/app/components/SubNav";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
import { TAPROOM_NAV, TARGETS_NAV } from "@/app/taproom/nav-config";

export default async function TargetsLayout({ children }: { children: React.ReactNode }) {
  await requirePage(CAP.targetsRead);
  return (
    <main className="px-4 sm:px-6">
      <StickyHeader>
        <SubNav entries={TAPROOM_NAV} mobile />
        <PageHeader title="Targets" description="Sales goals and achievement tracking" />
        <SubNav entries={TARGETS_NAV} />
      </StickyHeader>
      <div className="mt-4 pb-4 sm:pb-8">{children}</div>
    </main>
  );
}
