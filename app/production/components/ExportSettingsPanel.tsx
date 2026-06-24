"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import {
  useExciseTaxRatesQuery,
  useExportSquareCatalogQuery,
  useContractPartnersQuery,
  usePackagingQuery,
  useExportServiceMappingsQuery,
  useExportInvoiceDueDaysQuery,
} from "../hooks/queries";
import type { ExciseTaxRate, ExportServiceMapping } from "../types";
import { SquareCatalogSelect, SquareDiscountSelect } from "@/app/components/SquareCatalogSelect";

function ExciseTaxRateRow({
  rate,
  items,
  onSave,
}: {
  rate: ExciseTaxRate;
  items: { itemId: string; itemName: string; variations: { variationId: string; variationName: string }[] }[];
  onSave: (id: string, patch: Partial<ExciseTaxRate>) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);

  async function update(patch: Partial<ExciseTaxRate>) {
    setSaving(true);
    await onSave(rate.id, patch);
    setSaving(false);
  }

  return (
    <tr className="border-b border-zinc-800 last:border-0">
      <td className="px-4 py-2.5 text-zinc-200">{rate.name}</td>
      <td className="px-4 py-2.5 text-zinc-400">{rate.receiving_party ?? "—"}</td>
      <td className="px-4 py-2.5 text-zinc-400">{rate.unit}</td>
      <td className="px-4 py-2.5 text-right text-zinc-200">${rate.rate_usd.toFixed(2)}</td>
      <td className="px-4 py-2.5">
        <SquareCatalogSelect
          items={items}
          itemId={rate.square_catalog_item_id}
          variationId={rate.square_catalog_variation_id}
          onChange={(itemId, variationId) =>
            update({ square_catalog_item_id: itemId, square_catalog_variation_id: variationId })
          }
        />
      </td>
      <td className="px-4 py-2.5">
        <button
          onClick={() => update({ is_active: !rate.is_active })}
          disabled={saving}
          className={`text-xs px-2 py-1 rounded border transition-colors ${
            rate.is_active
              ? "bg-emerald-900/40 border-emerald-700 text-emerald-300 hover:bg-emerald-900/60"
              : "bg-zinc-900 border-zinc-700 text-zinc-500 hover:text-zinc-300"
          }`}
        >
          {rate.is_active ? "Active" : "Inactive"}
        </button>
      </td>
    </tr>
  );
}

function ExciseTaxRatesSection() {
  const qc = useQueryClient();
  const { data: rates = [] } = useExciseTaxRatesQuery();
  const { data: catalog } = useExportSquareCatalogQuery();
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftParty, setDraftParty] = useState("");
  const [draftUnit, setDraftUnit] = useState<"bbl" | "gallon">("bbl");
  const [draftRate, setDraftRate] = useState("");

  const items = catalog?.items ?? [];

  async function refresh() {
    await qc.invalidateQueries({ queryKey: queryKeys.production.exciseTaxRates() });
  }

  async function save(id: string, patch: Record<string, unknown>) {
    await fetch(`/api/production/export-settings/excise-tax-rates/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await refresh();
  }

  async function create() {
    if (!draftName || !draftRate) return;
    await fetch("/api/production/export-settings/excise-tax-rates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: draftName,
        receiving_party: draftParty || null,
        unit: draftUnit,
        rate_usd: Number(draftRate),
      }),
    });
    setCreating(false);
    setDraftName(""); setDraftParty(""); setDraftUnit("bbl"); setDraftRate("");
    await refresh();
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-zinc-200">Excise Tax Rates</h3>
        <button
          onClick={() => setCreating((c) => !c)}
          className="text-xs px-2.5 py-1 bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors"
        >
          {creating ? "Cancel" : "+ Add rate"}
        </button>
      </div>

      {creating && (
        <div className="flex items-end gap-2 mb-3 p-3 bg-zinc-900/60 border border-zinc-800 rounded">
          <input value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="Name"
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 w-40" />
          <input value={draftParty} onChange={(e) => setDraftParty(e.target.value)} placeholder="Receiving party"
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 w-40" />
          <select value={draftUnit} onChange={(e) => setDraftUnit(e.target.value as "bbl" | "gallon")}
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200">
            <option value="bbl">bbl</option>
            <option value="gallon">gallon</option>
          </select>
          <input value={draftRate} onChange={(e) => setDraftRate(e.target.value)} placeholder="Rate (USD)" type="number" step="0.01"
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 w-28" />
          <button onClick={create} className="text-xs px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded transition-colors">
            Save
          </button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Name</th>
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Receiving Party</th>
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Unit</th>
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Rate</th>
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Square Mapping</th>
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Status</th>
            </tr>
          </thead>
          <tbody>
            {rates.map((rate) => (
              <ExciseTaxRateRow key={rate.id} rate={rate} items={items} onSave={save} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const PACKAGING_SERVICE_LABELS: Record<"keg_cleaning" | "forklift", string> = {
  keg_cleaning: "Keg Cleaning",
  forklift: "Forklift",
};

function ServiceMappingRow({
  mapping,
  items,
  partnerLabel,
  onSave,
}: {
  mapping: ExportServiceMapping;
  items: { itemId: string; itemName: string; variations: { variationId: string; variationName: string }[] }[];
  partnerLabel: string;
  onSave: (mapping: ExportServiceMapping, patch: Partial<ExportServiceMapping>) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);

  async function update(patch: Partial<ExportServiceMapping>) {
    setSaving(true);
    await onSave(mapping, patch);
    setSaving(false);
  }

  return (
    <tr className="border-b border-zinc-800 last:border-0">
      <td className="px-4 py-2.5 text-zinc-300">{partnerLabel}</td>
      <td className="px-4 py-2.5 text-zinc-400">{mapping.display_name}</td>
      <td className="px-4 py-2.5">
        <SquareCatalogSelect
          items={items}
          itemId={mapping.square_catalog_item_id}
          variationId={mapping.square_catalog_variation_id}
          onChange={(itemId, variationId) =>
            update({ square_catalog_item_id: itemId, square_catalog_variation_id: variationId })
          }
        />
      </td>
      <td className="px-4 py-2.5 text-zinc-600">{saving ? "Saving…" : ""}</td>
    </tr>
  );
}

function PackagingFeeSection() {
  const { data: mappings = [] } = useExportServiceMappingsQuery();
  const { data: partners = [] } = useContractPartnersQuery();
  const { data: packagingItems = [] } = usePackagingQuery();
  const { data: catalog } = useExportSquareCatalogQuery();
  const qc = useQueryClient();
  const items = catalog?.items ?? [];

  // Packaging Fee is charged per shippable container, not per assembly
  // component (lid/paktech/tray/label) — see Spec 11 design doc.
  const containerItems = packagingItems.filter((p) => p.type === "keg" || p.type === "can");

  const feeRows = mappings.filter((m) => m.service_type === "packaging_fee");

  async function upsert(existing: ExportServiceMapping | null, patch: Partial<ExportServiceMapping> & { packaging_item_id: string; partner_id: string | null }) {
    await fetch("/api/production/export-settings/service-mappings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: existing?.id,
        service_type: "packaging_fee",
        partner_id: patch.partner_id,
        packaging_item_id: patch.packaging_item_id,
        display_name: existing?.display_name ?? "Packaging Fee",
        square_catalog_item_id: patch.square_catalog_item_id ?? existing?.square_catalog_item_id ?? null,
        square_catalog_variation_id: patch.square_catalog_variation_id ?? existing?.square_catalog_variation_id ?? null,
      }),
    });
    await qc.invalidateQueries({ queryKey: queryKeys.production.exportServiceMappings() });
  }

  return (
    <section>
      <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-2">Packaging Fee</h4>
      <p className="text-xs text-zinc-600 mb-2">Default mapping per packaging item, with optional per-partner overrides.</p>
      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Partner</th>
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Packaging</th>
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Square Mapping</th>
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500" />
            </tr>
          </thead>
          <tbody>
            {containerItems.map((pkg) => {
              const defaultRow = feeRows.find((m) => m.packaging_item_id === pkg.id && m.partner_id === null);
              return (
                <tr key={pkg.id} className="border-b border-zinc-800 last:border-0">
                  <td className="px-4 py-2.5 text-zinc-500 italic">Default</td>
                  <td className="px-4 py-2.5 text-zinc-300">{pkg.name}</td>
                  <td className="px-4 py-2.5">
                    <SquareCatalogSelect
                      items={items}
                      itemId={defaultRow?.square_catalog_item_id ?? null}
                      variationId={defaultRow?.square_catalog_variation_id ?? null}
                      onChange={(itemId, variationId) =>
                        upsert(defaultRow ?? null, { partner_id: null, packaging_item_id: pkg.id, square_catalog_item_id: itemId, square_catalog_variation_id: variationId })
                      }
                    />
                  </td>
                  <td />
                </tr>
              );
            })}
            {feeRows.filter((m) => m.partner_id !== null).map((m) => {
              const partner = partners.find((p) => p.id === m.partner_id);
              return (
                <ServiceMappingRow
                  key={m.id}
                  mapping={m}
                  items={items}
                  partnerLabel={partner?.company_name ?? "Unknown partner"}
                  onSave={(existing, patch) => upsert(existing, { ...patch, partner_id: existing.partner_id, packaging_item_id: existing.packaging_item_id! })}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SimpleServiceSection({ serviceType }: { serviceType: "keg_cleaning" | "forklift" }) {
  const { data: mappings = [] } = useExportServiceMappingsQuery();
  const { data: catalog } = useExportSquareCatalogQuery();
  const qc = useQueryClient();
  const items = catalog?.items ?? [];

  const row = mappings.find((m) => m.service_type === serviceType && m.partner_id === null) ?? null;

  async function upsert(itemId: string | null, variationId: string | null) {
    await fetch("/api/production/export-settings/service-mappings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: row?.id,
        service_type: serviceType,
        partner_id: null,
        display_name: PACKAGING_SERVICE_LABELS[serviceType],
        square_catalog_item_id: itemId,
        square_catalog_variation_id: variationId,
      }),
    });
    await qc.invalidateQueries({ queryKey: queryKeys.production.exportServiceMappings() });
  }

  return (
    <section>
      <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-2">{PACKAGING_SERVICE_LABELS[serviceType]}</h4>
      <SquareCatalogSelect
        items={items}
        itemId={row?.square_catalog_item_id ?? null}
        variationId={row?.square_catalog_variation_id ?? null}
        onChange={upsert}
      />
    </section>
  );
}

function BulkDiscountSection() {
  const { data: mappings = [] } = useExportServiceMappingsQuery();
  const { data: catalog } = useExportSquareCatalogQuery();
  const qc = useQueryClient();
  const discounts = catalog?.discounts ?? [];

  const row = mappings.find((m) => m.service_type === "bulk_discount" && m.partner_id === null) ?? null;

  async function upsert(discountId: string | null) {
    await fetch("/api/production/export-settings/service-mappings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: row?.id,
        service_type: "bulk_discount",
        partner_id: null,
        display_name: "Bulk Discount",
        square_catalog_discount_id: discountId,
      }),
    });
    await qc.invalidateQueries({ queryKey: queryKeys.production.exportServiceMappings() });
  }

  return (
    <section>
      <h3 className="text-sm font-medium text-zinc-200 mb-2">Bulk Discount</h3>
      <SquareDiscountSelect discounts={discounts} value={row?.square_catalog_discount_id ?? null} onChange={upsert} />
    </section>
  );
}

function InvoiceTermsSection() {
  const { data } = useExportInvoiceDueDaysQuery();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);

  const days = data?.days ?? 30;

  async function save() {
    const value = Number(draft || days);
    if (!Number.isInteger(value) || value < 1 || value > 365) return;
    setSaving(true);
    await fetch("/api/production/export-settings/invoice-due-days", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days: value }),
    });
    setDraft("");
    setSaving(false);
    await qc.invalidateQueries({ queryKey: queryKeys.production.exportInvoiceDueDays() });
  }

  return (
    <section>
      <h3 className="text-sm font-medium text-zinc-200 mb-2">Default Invoice Net Terms</h3>
      <p className="text-xs text-zinc-600 mb-2">
        Days until payment is due on a generated export invoice, used when a partner has no override set.
      </p>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={1}
          max={365}
          value={draft !== "" ? draft : days}
          onChange={(e) => setDraft(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 w-20"
        />
        <span className="text-xs text-zinc-500">days</span>
        <button onClick={save} disabled={saving}
          className="text-xs px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded transition-colors">
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </section>
  );
}

export default function ExportSettingsPanel({ scope }: { scope: "full" | "excise-only" }) {
  return (
    <div className="flex flex-col gap-8">
      <ExciseTaxRatesSection />
      {scope === "full" && (
        <>
          <section>
            <h3 className="text-sm font-medium text-zinc-200 mb-3">Service Mappings</h3>
            <div className="flex flex-col gap-6">
              <PackagingFeeSection />
              <SimpleServiceSection serviceType="keg_cleaning" />
              <SimpleServiceSection serviceType="forklift" />
            </div>
          </section>
          <BulkDiscountSection />
          <InvoiceTermsSection />
        </>
      )}
    </div>
  );
}
