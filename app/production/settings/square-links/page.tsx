"use client";

import SubNav from "@/app/components/SubNav";
import { PRODUCTION_NAV, SETTINGS_NAV } from "@/app/production/nav-config";
import PageHeader from "@/app/components/PageHeader";
import SquareMappingsPanel from "./SquareMappingsPanel";

export default function SquareMappingsPage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={PRODUCTION_NAV} mobile sticky />
      <PageHeader title="Settings" description="Deposits, export configuration, and Square integrations" />
      <SubNav entries={SETTINGS_NAV} sticky />
      <SquareMappingsPanel />
    </main>
  );
}
