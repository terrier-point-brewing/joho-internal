"use client";
import { Suspense } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import SubNav from "@/app/components/SubNav";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
import TabBar, { type TabDef } from "@/app/components/TabBar";
import { PRODUCTION_NAV } from "@/app/production/nav-config";
import IntakeTab from "@/app/production/components/IntakeTab";

export type IntakeSubtab = "plan" | "commitments";

const SUBTABS: TabDef<IntakeSubtab>[] = [
  { key: "plan",        label: "Plan" },
  { key: "commitments", label: "Commitments" },
];

/** The tab lives in the URL (?tab=commitments) so other pages can link to it. */
function IntakeContent() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const sub: IntakeSubtab = params.get("tab") === "commitments" ? "commitments" : "plan";
  const setSub = (key: IntakeSubtab) => router.replace(key === "plan" ? pathname : `${pathname}?tab=${key}`, { scroll: false });

  return (
    <main className="px-4 sm:px-6">
      <StickyHeader>
        <SubNav entries={PRODUCTION_NAV} mobile />
        <PageHeader
          title="Intake"
          description="What to brew next, and who it is for"
        />
        <TabBar tabs={SUBTABS} activeKey={sub} onSelect={setSub} className="mb-0" />
      </StickyHeader>
      <div className="mt-6 pb-4 sm:pb-8"><IntakeTab sub={sub} /></div>
    </main>
  );
}

export default function IntakePage() {
  return <Suspense><IntakeContent /></Suspense>;
}
