"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import {
  useExciseTaxRatesQuery,
  useExportSquareCatalogQuery,
} from "../hooks/queries";
import type { ExciseTaxRate } from "../types";
import { SquareCatalogSelect } from "@/app/components/SquareCatalogSelect";

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

export default function ExportSettingsPanel({ scope }: { scope: "full" | "excise-only" }) {
  return (
    <div className="flex flex-col gap-8">
      <ExciseTaxRatesSection />
      {scope === "full" && (
        <p className="text-xs text-zinc-600 italic">Service mappings + bulk discount sections added in Task 9.</p>
      )}
    </div>
  );
}
