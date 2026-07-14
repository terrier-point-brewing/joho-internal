"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import FinanceNav from "../../FinanceNav";
import PageHeader from "@/app/components/PageHeader";
import SettingsNav from "../SettingsNav";
import Banner from "@/app/components/ui/Banner";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import type { TaxAuthority } from "@/lib/tax/authorities";
import { useTaxPartiesQuery } from "@/app/finance/tax/hooks/useTaxData";
import IdentityForm from "./IdentityForm";
import ReferenceDisclosure from "./ReferenceDisclosure";
import ExciseRatesSection from "./ExciseRatesSection";

/** Maps a receiving-party authority key to the worksheet-template key
 *  (`lib/tax/parties/*`) that owns its Square mappings + reference data. */
const TEMPLATE_BY_AUTHORITY: Record<string, string> = { nc_dor: "nc_dor_sales_use" };

/**
 * Finance → Settings → Tax Filing: per-authority Square mappings, excise
 * rates, and the statutory reference tables the worksheet calc relies on.
 * Authorities come from `GET /api/tax/authorities`; worksheet-template
 * metadata (Square mapping schema + reference view) comes from
 * `GET /api/tax/parties`, matched via TEMPLATE_BY_AUTHORITY.
 */
export default function TaxFilingSettingsPage() {
  const authoritiesQuery = useQuery({
    queryKey: queryKeys.tax.authorities(),
    queryFn: () => fetchJson<TaxAuthority[]>("/api/tax/authorities"),
  });
  const authorities = authoritiesQuery.data ?? [];
  const partiesQuery = useTaxPartiesQuery();
  const parties = partiesQuery.data ?? [];

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const authority = authorities.find((a) => a.key === selectedKey) ?? authorities[0];

  const templateKey = authority ? TEMPLATE_BY_AUTHORITY[authority.key] : undefined;
  const template = templateKey ? parties.find((p) => p.key === templateKey) : undefined;

  const isLoading = authoritiesQuery.isLoading || partiesQuery.isLoading;
  const isError = authoritiesQuery.isError || partiesQuery.isError;

  return (
    <div className="flex flex-col h-full bg-canvas text-primary">
      <FinanceNav mobile />
      <div className="shrink-0 px-4 sm:px-6">
        <PageHeader
          title="Tax Filing"
          description="Per-authority Square mappings, excise rates, and the statutory tables the worksheet relies on."
        />
      </div>
      <SettingsNav />
      <div className="flex-1 overflow-auto px-4 sm:px-6 py-4 flex flex-col gap-6">
        {isLoading && <p className="text-sm text-faint">Loading…</p>}
        {isError && (
          <Banner tone="danger">
            {authoritiesQuery.error instanceof Error
              ? authoritiesQuery.error.message
              : partiesQuery.error instanceof Error
                ? partiesQuery.error.message
                : "Failed to load tax settings."}
          </Banner>
        )}
        {!isLoading && !isError && !authority && (
          <p className="text-sm text-faint">No tax authorities registered.</p>
        )}

        {authority && (
          <>
            {authorities.length >= 1 && (
              <label className="flex items-center gap-2 text-sm text-body">
                Authority
                <select
                  className="inp-sm w-auto"
                  value={authority.key}
                  onChange={(e) => setSelectedKey(e.target.value)}
                >
                  {authorities.map((a) => (
                    <option key={a.key} value={a.key}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {template && template.settingsSchema.length > 0 && (
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-primary">Square Mappings</h3>
                <IdentityForm
                  schema={template.settingsSchema}
                  endpoint={`/api/tax/profiles/${template.key}`}
                  queryKey={queryKeys.tax.profile(template.key)}
                  savedLabel="Square mappings saved."
                />
              </section>
            )}

            {(authority.kind === "excise" || authority.kind === "both") && (
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-primary">Excise Rates</h3>
                <ExciseRatesSection partyKey={authority.key} />
              </section>
            )}

            {template && (
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-primary">Reference Data</h3>
                <ReferenceDisclosure referenceView={template.referenceView} />
              </section>
            )}

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
    </div>
  );
}
