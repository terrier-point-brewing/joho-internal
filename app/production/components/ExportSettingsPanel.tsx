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
import RecipeLinkMatrix from "./RecipeLinkMatrix";

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
  const [name, setName] = useState(rate.name);
  const [party, setParty] = useState(rate.receiving_party ?? "");
  const [unit, setUnit] = useState<"bbl" | "gallon">(rate.unit);
  const [rateUsd, setRateUsd] = useState(String(rate.rate_usd));

  async function update(patch: Partial<ExciseTaxRate>) {
    setSaving(true);
    await onSave(rate.id, patch);
    setSaving(false);
  }

  function commitName() { if (name !== rate.name) update({ name }); }
  function commitParty() { if ((party || null) !== rate.receiving_party) update({ receiving_party: party || null }); }
  function commitRate() {
    const n = Number(rateUsd);
    if (!isNaN(n) && n !== rate.rate_usd) update({ rate_usd: n });
  }

  return (
    <tr className="border-b border-zinc-800 last:border-0">
      <td className="px-4 py-2.5">
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={commitName}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 w-32" />
      </td>
      <td className="px-4 py-2.5">
        <input value={party} onChange={(e) => setParty(e.target.value)} onBlur={commitParty} placeholder="—"
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 w-32" />
      </td>
      <td className="px-4 py-2.5">
        <select value={unit} onChange={(e) => { const v = e.target.value as "bbl" | "gallon"; setUnit(v); update({ unit: v }); }}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200">
          <option value="bbl">bbl</option>
          <option value="gallon">gallon</option>
        </select>
      </td>
      <td className="px-4 py-2.5 text-right">
        <input type="number" step="0.01" value={rateUsd} onChange={(e) => setRateUsd(e.target.value)} onBlur={commitRate}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 w-24 text-right" />
      </td>
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

const KEG_VOL_LABELS: Record<number, string> = { 1984: "1/2 BBL", 992: "1/4 BBL", 661: "1/6 BBL" };
const CAN_FORMAT_LABELS: Record<"loose" | "case", string> = { loose: "Loose Can", case: "Case" };

interface VolumeClass {
  piType: "keg" | "can";
  volumeFlOz: number;
  format: "loose" | "case" | null;
  label: string;
}

function deriveVolumeClasses(packagingItems: { id: string; type: string; volume_fl_oz: number | null }[]): VolumeClass[] {
  const seen = new Map<string, VolumeClass>();
  for (const pi of packagingItems) {
    if ((pi.type !== "keg" && pi.type !== "can") || pi.volume_fl_oz == null) continue;
    const piType = pi.type as "keg" | "can";
    const vol = pi.volume_fl_oz;
    if (piType === "keg") {
      const k = `keg|${vol}|null`;
      if (!seen.has(k)) {
        const size = KEG_VOL_LABELS[vol] ?? `${vol} fl oz`;
        seen.set(k, { piType, volumeFlOz: vol, format: null, label: `${size} Keg` });
      }
    } else {
      for (const fmt of ["loose", "case"] as const) {
        const k = `can|${vol}|${fmt}`;
        if (!seen.has(k)) {
          seen.set(k, { piType, volumeFlOz: vol, format: fmt, label: `${vol}oz Can · ${CAN_FORMAT_LABELS[fmt]}` });
        }
      }
    }
  }
  return [...seen.values()].sort((a, b) => {
    if (a.piType !== b.piType) return a.piType === "keg" ? -1 : 1;
    if (a.piType === "keg") return b.volumeFlOz - a.volumeFlOz;
    if (a.volumeFlOz !== b.volumeFlOz) return a.volumeFlOz - b.volumeFlOz;
    return (a.format === "loose" ? 0 : 1) - (b.format === "loose" ? 0 : 1);
  });
}

function VolumeClassRow({
  vc,
  packagingItems,
  feeRows,
  partners,
  items,
  onSave,
}: {
  vc: VolumeClass;
  packagingItems: { id: string; type: string; volume_fl_oz: number | null }[];
  feeRows: ExportServiceMapping[];
  partners: { id: string; company_name: string }[];
  items: { itemId: string; itemName: string; variations: { variationId: string; variationName: string }[] }[];
  onSave: (payload: {
    type: "keg" | "can"; volume_fl_oz: number; format: "case" | "loose" | null;
    partner_id: string | null; square_catalog_item_id: string | null; square_catalog_variation_id: string | null;
    display_name: string;
  }) => Promise<void>;
}) {
  const classItemIds = new Set(
    packagingItems
      .filter((pi) => pi.type === vc.piType && pi.volume_fl_oz === vc.volumeFlOz)
      .map((pi) => pi.id)
  );

  function getMapping(partnerId: string | null): ExportServiceMapping | null {
    return (
      feeRows.find(
        (m) => m.packaging_item_id !== null && classItemIds.has(m.packaging_item_id) &&
          m.packaging_format === vc.format && m.partner_id === partnerId
      ) ?? null
    );
  }

  const defaultRow = getMapping(null);
  const overridePartnerIds = new Set(
    feeRows
      .filter((m) => m.packaging_item_id !== null && classItemIds.has(m.packaging_item_id) && m.packaging_format === vc.format && m.partner_id !== null)
      .map((m) => m.partner_id!)
  );

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-zinc-300">{vc.label}</span>
      <div className="flex items-center gap-2 pl-3">
        <span className="text-xs text-zinc-500 italic w-28">Default</span>
        <SquareCatalogSelect
          items={items}
          itemId={defaultRow?.square_catalog_item_id ?? null}
          variationId={defaultRow?.square_catalog_variation_id ?? null}
          onChange={(itemId, variationId) =>
            onSave({
              type: vc.piType, volume_fl_oz: vc.volumeFlOz, format: vc.format,
              partner_id: null, square_catalog_item_id: itemId, square_catalog_variation_id: variationId,
              display_name: "Packaging Fee",
            })
          }
        />
      </div>
      {[...overridePartnerIds].map((partnerId) => {
        const partner = partners.find((p) => p.id === partnerId);
        const overrideRow = getMapping(partnerId);
        return (
          <div key={partnerId} className="flex items-center gap-2 pl-3">
            <span className="text-xs text-zinc-300 w-28 truncate">{partner?.company_name ?? "Unknown"}</span>
            <SquareCatalogSelect
              items={items}
              itemId={overrideRow?.square_catalog_item_id ?? null}
              variationId={overrideRow?.square_catalog_variation_id ?? null}
              onChange={(itemId, variationId) =>
                onSave({
                  type: vc.piType, volume_fl_oz: vc.volumeFlOz, format: vc.format,
                  partner_id: partnerId, square_catalog_item_id: itemId, square_catalog_variation_id: variationId,
                  display_name: "Packaging Fee",
                })
              }
            />
          </div>
        );
      })}
      <div className="pl-3">
        <PartnerOverridePicker
          partners={partners}
          excludeIds={overridePartnerIds}
          onAdd={(partnerId) =>
            onSave({
              type: vc.piType, volume_fl_oz: vc.volumeFlOz, format: vc.format,
              partner_id: partnerId, square_catalog_item_id: null, square_catalog_variation_id: null,
              display_name: "Packaging Fee",
            })
          }
        />
      </div>
    </div>
  );
}

function PackagingFeeSection() {
  const { data: mappings = [] } = useExportServiceMappingsQuery();
  const { data: partners = [] } = useContractPartnersQuery();
  const { data: packagingItems = [] } = usePackagingQuery();
  const { data: catalog } = useExportSquareCatalogQuery();
  const qc = useQueryClient();
  const items = catalog?.items ?? [];

  const feeRows = mappings.filter((m) => m.service_type === "packaging_fee");
  const volumeClasses = deriveVolumeClasses(packagingItems);

  async function save(payload: {
    type: "keg" | "can"; volume_fl_oz: number; format: "case" | "loose" | null;
    partner_id: string | null; square_catalog_item_id: string | null; square_catalog_variation_id: string | null;
    display_name: string;
  }) {
    if (!payload.square_catalog_item_id || !payload.square_catalog_variation_id) return;
    await fetch("/api/production/export-settings/packaging-fee-class", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await qc.invalidateQueries({ queryKey: queryKeys.production.exportServiceMappings() });
  }

  return (
    <section>
      <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-2">Packaging Fee</h4>
      <p className="text-xs text-zinc-600 mb-3">
        One mapping per container volume class. Saving a class updates all matching packaging items (e.g. saving "1/6 BBL Keg" updates both generic and partner-specific 1/6 keg items). Cans require separate Case and Loose mappings.
      </p>
      <div className="flex flex-col gap-5">
        {volumeClasses.map((vc) => (
          <VolumeClassRow
            key={`${vc.piType}|${vc.volumeFlOz}|${vc.format}`}
            vc={vc}
            packagingItems={packagingItems}
            feeRows={feeRows}
            partners={partners}
            items={items}
            onSave={save}
          />
        ))}
      </div>
    </section>
  );
}

export function PartnerOverridePicker({ partners, excludeIds, onAdd }: {
  partners: { id: string; company_name: string }[];
  excludeIds: Set<string>;
  onAdd: (partnerId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [partnerId, setPartnerId] = useState("");
  const available = partners.filter((p) => !excludeIds.has(p.id));

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-xs text-amber-500 hover:text-amber-400 transition-colors">
        + Add partner override
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)}
        className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200">
        <option value="">— select partner —</option>
        {available.map((p) => <option key={p.id} value={p.id}>{p.company_name}</option>)}
      </select>
      <button
        onClick={() => { if (partnerId) { onAdd(partnerId); setOpen(false); setPartnerId(""); } }}
        disabled={!partnerId}
        className="text-xs px-2 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded transition-colors disabled:opacity-40"
      >
        Add
      </button>
      <button onClick={() => { setOpen(false); setPartnerId(""); }} className="text-xs text-zinc-500 hover:text-zinc-300">
        Cancel
      </button>
    </div>
  );
}

function SimpleServiceSection({ serviceType }: { serviceType: "keg_cleaning" | "forklift" }) {
  const { data: mappings = [] } = useExportServiceMappingsQuery();
  const { data: partners = [] } = useContractPartnersQuery();
  const { data: catalog } = useExportSquareCatalogQuery();
  const qc = useQueryClient();
  const items = catalog?.items ?? [];

  const rows = mappings.filter((m) => m.service_type === serviceType);
  const defaultRow = rows.find((m) => m.partner_id === null) ?? null;
  const overrideRows = rows.filter((m) => m.partner_id !== null);

  async function upsert(existing: ExportServiceMapping | null, partnerId: string | null, itemId: string | null, variationId: string | null) {
    await fetch("/api/production/export-settings/service-mappings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: existing?.id,
        service_type: serviceType,
        partner_id: partnerId,
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
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500 italic w-28">Default</span>
          <SquareCatalogSelect
            items={items}
            itemId={defaultRow?.square_catalog_item_id ?? null}
            variationId={defaultRow?.square_catalog_variation_id ?? null}
            onChange={(itemId, variationId) => upsert(defaultRow, null, itemId, variationId)}
          />
        </div>
        {overrideRows.map((m) => {
          const partner = partners.find((p) => p.id === m.partner_id);
          return (
            <div key={m.id} className="flex items-center gap-2">
              <span className="text-xs text-zinc-300 w-28 truncate">{partner?.company_name ?? "Unknown partner"}</span>
              <SquareCatalogSelect
                items={items}
                itemId={m.square_catalog_item_id}
                variationId={m.square_catalog_variation_id}
                onChange={(itemId, variationId) => upsert(m, m.partner_id, itemId, variationId)}
              />
            </div>
          );
        })}
        <PartnerOverridePicker
          partners={partners}
          excludeIds={new Set(overrideRows.map((m) => m.partner_id!))}
          onAdd={(partnerId) => upsert(null, partnerId, null, null)}
        />
      </div>
    </section>
  );
}

function BulkDiscountSection() {
  const { data: mappings = [] } = useExportServiceMappingsQuery();
  const { data: partners = [] } = useContractPartnersQuery();
  const { data: catalog } = useExportSquareCatalogQuery();
  const qc = useQueryClient();
  const discounts = catalog?.discounts ?? [];

  const rows = mappings.filter((m) => m.service_type === "bulk_discount");
  const defaultRow = rows.find((m) => m.partner_id === null) ?? null;
  const overrideRows = rows.filter((m) => m.partner_id !== null);

  async function upsert(existing: ExportServiceMapping | null, partnerId: string | null, discountId: string | null) {
    await fetch("/api/production/export-settings/service-mappings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: existing?.id,
        service_type: "bulk_discount",
        partner_id: partnerId,
        display_name: "Bulk Discount",
        square_catalog_discount_id: discountId,
      }),
    });
    await qc.invalidateQueries({ queryKey: queryKeys.production.exportServiceMappings() });
  }

  return (
    <section>
      <h3 className="text-sm font-medium text-zinc-200 mb-2">Bulk Discount</h3>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500 italic w-28">Default</span>
          <SquareDiscountSelect discounts={discounts} value={defaultRow?.square_catalog_discount_id ?? null} onChange={(id) => upsert(defaultRow, null, id)} />
        </div>
        {overrideRows.map((m) => {
          const partner = partners.find((p) => p.id === m.partner_id);
          return (
            <div key={m.id} className="flex items-center gap-2">
              <span className="text-xs text-zinc-300 w-28 truncate">{partner?.company_name ?? "Unknown partner"}</span>
              <SquareDiscountSelect discounts={discounts} value={m.square_catalog_discount_id} onChange={(id) => upsert(m, m.partner_id, id)} />
            </div>
          );
        })}
        <PartnerOverridePicker
          partners={partners}
          excludeIds={new Set(overrideRows.map((m) => m.partner_id!))}
          onAdd={(partnerId) => upsert(null, partnerId, null)}
        />
      </div>
    </section>
  );
}

function DistributionDiscountSection() {
  const { data: mappings = [] } = useExportServiceMappingsQuery();
  const { data: partners = [] } = useContractPartnersQuery();
  const { data: catalog } = useExportSquareCatalogQuery();
  const qc = useQueryClient();
  const discounts = catalog?.discounts ?? [];

  const rows = mappings.filter((m) => m.service_type === "distribution_discount");
  const defaultRow = rows.find((m) => m.partner_id === null) ?? null;
  const overrideRows = rows.filter((m) => m.partner_id !== null);

  async function upsert(existing: ExportServiceMapping | null, partnerId: string | null, discountId: string | null) {
    await fetch("/api/production/export-settings/service-mappings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: existing?.id,
        service_type: "distribution_discount",
        partner_id: partnerId,
        display_name: "Distribution Discount",
        square_catalog_discount_id: discountId,
      }),
    });
    await qc.invalidateQueries({ queryKey: queryKeys.production.exportServiceMappings() });
  }

  return (
    <section>
      <h3 className="text-sm font-medium text-zinc-200 mb-2">Distribution Discount</h3>
      <p className="text-xs text-zinc-600 mb-2">
        Applied to product line items on Distribution invoices. Optional — omit to generate without a discount.
      </p>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500 italic w-28">Default</span>
          <SquareDiscountSelect
            discounts={discounts}
            value={defaultRow?.square_catalog_discount_id ?? null}
            onChange={(id) => upsert(defaultRow, null, id)}
          />
        </div>
        {overrideRows.map((m) => {
          const partner = partners.find((p) => p.id === m.partner_id);
          return (
            <div key={m.id} className="flex items-center gap-2">
              <span className="text-xs text-zinc-300 w-28 truncate">{partner?.company_name ?? "Unknown partner"}</span>
              <SquareDiscountSelect
                discounts={discounts}
                value={m.square_catalog_discount_id}
                onChange={(id) => upsert(m, m.partner_id, id)}
              />
            </div>
          );
        })}
        <PartnerOverridePicker
          partners={partners}
          excludeIds={new Set(overrideRows.map((m) => m.partner_id!))}
          onAdd={(partnerId) => upsert(null, partnerId, null)}
        />
      </div>
    </section>
  );
}

function WholesaleDiscountSection() {
  const { data: mappings = [] } = useExportServiceMappingsQuery();
  const { data: partners = [] } = useContractPartnersQuery();
  const { data: catalog } = useExportSquareCatalogQuery();
  const qc = useQueryClient();
  const discounts = catalog?.discounts ?? [];

  const rows = mappings.filter((m) => m.service_type === "wholesale_discount");
  const defaultRow = rows.find((m) => m.partner_id === null) ?? null;
  const overrideRows = rows.filter((m) => m.partner_id !== null);

  async function upsert(existing: ExportServiceMapping | null, partnerId: string | null, discountId: string | null) {
    await fetch("/api/production/export-settings/service-mappings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: existing?.id,
        service_type: "wholesale_discount",
        partner_id: partnerId,
        display_name: "Wholesale Discount",
        square_catalog_discount_id: discountId,
      }),
    });
    await qc.invalidateQueries({ queryKey: queryKeys.production.exportServiceMappings() });
  }

  return (
    <section>
      <h3 className="text-sm font-medium text-zinc-200 mb-2">Wholesale Discount</h3>
      <p className="text-xs text-zinc-600 mb-2">
        Applied to product line items on Wholesale invoices. Optional — omit to generate without a discount.
      </p>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500 italic w-28">Default</span>
          <SquareDiscountSelect
            discounts={discounts}
            value={defaultRow?.square_catalog_discount_id ?? null}
            onChange={(id) => upsert(defaultRow, null, id)}
          />
        </div>
        {overrideRows.map((m) => {
          const partner = partners.find((p) => p.id === m.partner_id);
          return (
            <div key={m.id} className="flex items-center gap-2">
              <span className="text-xs text-zinc-300 w-28 truncate">{partner?.company_name ?? "Unknown partner"}</span>
              <SquareDiscountSelect
                discounts={discounts}
                value={m.square_catalog_discount_id}
                onChange={(id) => upsert(m, m.partner_id, id)}
              />
            </div>
          );
        })}
        <PartnerOverridePicker
          partners={partners}
          excludeIds={new Set(overrideRows.map((m) => m.partner_id!))}
          onAdd={(partnerId) => upsert(null, partnerId, null)}
        />
      </div>
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
          <DistributionDiscountSection />
          <WholesaleDiscountSection />
          <InvoiceTermsSection />
          <section>
            <h3 className="text-sm font-medium text-zinc-200 mb-2">Product Square Links</h3>
            <p className="text-xs text-zinc-600 mb-3">
              Map each recipe + container format to a Square catalog variation for invoice line items.
            </p>
            <RecipeLinkMatrix />
          </section>
        </>
      )}
    </div>
  );
}
