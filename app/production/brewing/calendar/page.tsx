"use client";
import { useRouter } from "next/navigation";
import SubNav from "@/app/components/SubNav";
import { PRODUCTION_NAV, BREWING_NAV } from "@/app/production/nav-config";
import CalendarTab from "@/app/production/components/CalendarTab";
import { useUserRole } from "@/lib/hooks/useUserRole";

export default function CalendarPage() {
  const router = useRouter();
  const { role, loading } = useUserRole();
  if (!loading && role !== "admin") { router.replace("/production/brewing/floorplan"); return null; }

  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={PRODUCTION_NAV} mobile sticky />
      <SubNav entries={BREWING_NAV} sticky />
      <CalendarTab />
    </main>
  );
}
