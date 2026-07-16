"use client";

import FinanceNav from "../../FinanceNav";
import PageHeader from "@/app/components/PageHeader";
import SettingsNav from "../SettingsNav";
import { queryKeys } from "@/lib/query-keys";
import { ENTITY_PROFILE_SCHEMA } from "@/lib/tax/entity";
import { LEGAL_REPRESENTATIVE_SCHEMA } from "@/lib/tax/legalRepresentative";
import IdentityForm from "../tax-filing/IdentityForm";
import RegistrationsSection from "./RegistrationsSection";

/**
 * Finance → Settings → Tax Profile: the brewery's own filer identity
 * (`tax_entity_profile`, singleton — lib/tax/entity.ts) plus the
 * account/license numbers registered with each tax authority
 * (`tax_authorities` — lib/tax/authorities.ts).
 */
export default function TaxProfileSettingsPage() {
  return (
    <div className="flex flex-col h-full bg-canvas text-primary">
      <FinanceNav mobile />
      <div className="shrink-0 px-4 sm:px-6">
        <PageHeader
          title="Tax Profile"
          description="Business identity, the legal representative who signs filings, and the account/license numbers registered with each tax authority."
        />
      </div>
      <SettingsNav />
      <div className="flex-1 overflow-auto px-4 sm:px-6 py-4 flex flex-col gap-6">
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-primary">Filer Identity</h3>
          <IdentityForm
            schema={ENTITY_PROFILE_SCHEMA}
            endpoint="/api/tax/entity-profile"
            queryKey={queryKeys.tax.entityProfile()}
            savedLabel="Tax profile saved."
          />
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-primary">Legal Representative</h3>
          <IdentityForm
            schema={LEGAL_REPRESENTATIVE_SCHEMA}
            endpoint="/api/tax/legal-representative"
            queryKey={queryKeys.tax.legalRepresentative()}
            savedLabel="Legal representative saved."
          />
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-primary">Registrations</h3>
          <RegistrationsSection />
        </section>
      </div>
    </div>
  );
}
