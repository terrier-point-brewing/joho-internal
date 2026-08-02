"use client";

import { useState } from "react";
import Link from "next/link";
import Banner from "@/app/components/ui/Banner";
import { queryKeys } from "@/lib/query-keys";
import { useTaxPartiesQuery } from "@/app/finance/tax/hooks/useTaxData";
import IdentityForm from "./IdentityForm";
import ReferenceDisclosure from "./ReferenceDisclosure";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";

/**
 * Finance → Settings → Tax Filing: one pane per tax-filing MODULE (party
 * template — `lib/tax/parties/*`), not per authority. Each module shows only
 * the config its own calc needs beyond Tax Profile: its Square mappings
 * (`settingsSchema`) and its statutory reference tables (`referenceView`,
 * now sourced read-only from the canonical `tax_rates` registry). Tax rates
 * are fixed data, no longer user-editable here. Modules come from
 * `GET /api/tax/parties` (`useTaxPartiesQuery`).
 */
export default function TaxFilingSettingsPage() {
  const partiesQuery = useTaxPartiesQuery();
  const parties = partiesQuery.data ?? [];

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const activeModule = parties.find((p) => p.key === selectedKey) ?? parties[0];

  return (
    <>
      <div className="shrink-0 px-4 sm:px-6">
        <StickyHeader>
          <PageHeader
            title="Tax Filing"
            description="Per-module Square mappings and the statutory rate tables each filing worksheet relies on."
          />
        </StickyHeader>
      </div>
      <div className="flex-1 overflow-auto px-4 sm:px-6 py-4 flex flex-col gap-6">
        {partiesQuery.isLoading && <p className="text-sm text-faint">Loading…</p>}
        {partiesQuery.isError && (
          <Banner tone="danger">
            {partiesQuery.error instanceof Error ? partiesQuery.error.message : "Failed to load tax modules."}
          </Banner>
        )}
        {!partiesQuery.isLoading && !partiesQuery.isError && !activeModule && (
          <p className="text-sm text-faint">No tax filing modules registered.</p>
        )}

        {activeModule && (
          <>
            {parties.length >= 1 && (
              <label className="flex items-center gap-2 text-sm text-body">
                Module
                <select
                  className="inp-sm w-auto"
                  value={activeModule.key}
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

            {activeModule.settingsSchema.length > 0 && (
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-primary">Square Mappings</h3>
                <IdentityForm
                  schema={activeModule.settingsSchema}
                  endpoint={`/api/tax/profiles/${activeModule.key}`}
                  queryKey={queryKeys.tax.profile(activeModule.key)}
                  savedLabel="Square mappings saved."
                />
              </section>
            )}

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-primary">Reference Data</h3>
              <ReferenceDisclosure referenceView={activeModule.referenceView} />
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-primary">Schedules</h3>
              <p className="text-sm text-secondary">
                Filing schedules and worksheets live in the{" "}
                <Link href="/finance/tax" className="text-accent hover:underline">
                  Tax
                </Link>{" "}
                area.
              </p>
            </section>
          </>
        )}
      </div>
    </>
  );
}
