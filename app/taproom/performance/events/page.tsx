"use client";
import SubNav from "@/app/components/SubNav";
import { TAPROOM_NAV, PERFORMANCE_NAV } from "@/app/taproom/nav-config";
import EventsTab from "@/app/taproom/components/EventsTab";

export default function EventsPage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={TAPROOM_NAV} mobile />
      <SubNav entries={PERFORMANCE_NAV} sticky />
      <EventsTab />
    </main>
  );
}
