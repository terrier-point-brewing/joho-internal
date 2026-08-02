"use client";
import { useRouter } from "next/navigation";
import SubNav from "@/app/components/SubNav";
import { PRODUCTION_NAV, BREWING_NAV } from "@/app/production/nav-config";
import CalendarTab from "@/app/production/components/CalendarTab";
import { usePermissions } from "@/lib/hooks/useUserRole";
import { CAP } from "@/lib/auth/capabilities";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";

export default function CalendarPage() {
  const router = useRouter();
  const { can, loading } = usePermissions();
  if (!loading && !can(CAP.brewingCalendarAdmin)) { router.replace("/production/brewing/floorplan"); return null; }

  return (
    <main className="px-4 sm:px-6">
      <StickyHeader>
        <SubNav entries={PRODUCTION_NAV} mobile />
        <PageHeader title="Brewing" description="Batch tracking, fermentation monitoring, and equipment scheduling" />
        <SubNav entries={BREWING_NAV} />
      </StickyHeader>
      <div className="mt-4 pb-4 sm:pb-8"><CalendarTab /></div>
    </main>
  );
}
