"use client";

import { queryKeys } from "@/lib/query-keys";
import { ENTITY_PROFILE_SCHEMA } from "@/lib/tax/entity";
import { LEGAL_REPRESENTATIVE_SCHEMA } from "@/lib/tax/legalRepresentative";
import { BANK_ACCOUNT_SCHEMA } from "@/lib/tax/bankAccount";
import IdentityForm from "@/app/settings/tax/filing/IdentityForm";
import RegistrationsSection from "./RegistrationsSection";
import SettingsHeader from "@/app/settings/SettingsHeader";

/**
 * Finance → Settings → Tax Profile: the brewery's own filer identity
 * (`tax_entity_profile`, singleton — lib/tax/entity.ts), the bank account
 * filings are paid from/refunded to (`tax_bank_account`, singleton —
 * lib/tax/bankAccount.ts), plus the account/license numbers registered with
 * each tax authority (`tax_authorities` — lib/tax/authorities.ts).
 */
export default function TaxProfileSettingsPage() {
  return (
    <>
      <div className="shrink-0 px-4 sm:px-6">
        <SettingsHeader
          title="Tax Profile"
          description="Business identity, the legal representative who signs filings, the bank account filings are paid from, and the account/license numbers registered with each tax authority."
        />
      </div>
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
          <h3 className="text-sm font-semibold text-primary">Bank Account</h3>
          <IdentityForm
            schema={BANK_ACCOUNT_SCHEMA}
            endpoint="/api/tax/bank-account"
            queryKey={queryKeys.tax.bankAccount()}
            savedLabel="Bank account saved."
          />
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-primary">Registrations</h3>
          <RegistrationsSection />
        </section>
      </div>
    </>
  );
}
