"use client";

import { useState } from "react";
import FinanceNav from "../../FinanceNav";
import PageHeader from "@/app/components/PageHeader";
import SettingsNav from "../SettingsNav";
import Banner from "@/app/components/ui/Banner";
import { useTaxPartiesQuery } from "@/app/finance/tax/hooks/useTaxData";
import { IDENTITY_SCHEMA } from "@/lib/tax/identity";
import IdentityForm from "./IdentityForm";
import ReferenceDisclosure from "./ReferenceDisclosure";

/**
 * Finance → Settings → Tax Filing: per-party filing identity (FEIN/SSN,
 * contact info, account ID — lib/tax/parties/*'s `settingsSchema`) plus a
 * read-only statutory reference disclosure (`referenceView`) so a filer can
 * audit the rate/tier tables the worksheet calc uses. Parties come from
 * `GET /api/tax/parties`; only one party (NC DOR Sales & Use) is registered
 * today, so the selector only renders once a second party exists.
 */
export default function TaxFilingSettingsPage() {
  const partiesQuery = useTaxPartiesQuery();
  const parties = partiesQuery.data ?? [];
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const party = parties.find((p) => p.key === selectedKey) ?? parties[0];

  return (
    <div className="flex flex-col h-full bg-canvas text-primary">
      <FinanceNav mobile />
      <div className="shrink-0 px-4 sm:px-6">
        <PageHeader
          title="Tax Filing"
          description="Per-party filing identity and the statutory rate tables the worksheet calc relies on."
        />
      </div>
      <SettingsNav />
      <div className="flex-1 overflow-auto px-4 sm:px-6 py-4 flex flex-col gap-6">
        {partiesQuery.isLoading && <p className="text-sm text-faint">Loading…</p>}
        {partiesQuery.isError && (
          <Banner tone="danger">
            {partiesQuery.error instanceof Error ? partiesQuery.error.message : "Failed to load tax parties."}
          </Banner>
        )}
        {!partiesQuery.isLoading && !partiesQuery.isError && !party && (
          <p className="text-sm text-faint">No tax parties registered.</p>
        )}

        {party && (
          <>
            {parties.length > 1 && (
              <label className="flex items-center gap-2 text-sm text-body">
                Party
                <select
                  className="inp-sm w-auto"
                  value={party.key}
                  onChange={(e) => setSelectedKey(e.target.value)}
                >
                  {parties.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-primary">Filing Identity</h3>
              <IdentityForm partyKey={party.key} schema={IDENTITY_SCHEMA} />
            </section>

            {party.settingsSchema.length > 0 && (
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-primary">Party Settings</h3>
                <IdentityForm partyKey={party.key} schema={party.settingsSchema} />
              </section>
            )}

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-primary">Reference Data</h3>
              <ReferenceDisclosure referenceView={party.referenceView} />
            </section>
          </>
        )}
      </div>
    </div>
  );
}
