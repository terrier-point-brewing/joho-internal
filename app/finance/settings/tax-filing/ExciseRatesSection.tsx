"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { useExciseTaxRatesQuery, useExportSquareCatalogQuery } from "@/app/production/hooks/queries";
import type { ExciseTaxRate } from "@/app/production/types";
import { SquareCatalogSelect } from "@/app/components/SquareCatalogSelect";

function ExciseTaxRateRow({
  rate,
  items,
  showParty,
  onSave,
}: {
  rate: ExciseTaxRate;
  items: { itemId: string; itemName: string; variations: { variationId: string; variationName: string }[] }[];
  showParty: boolean;
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
    <tr className="border-b border-line last:border-0">
      <td className="px-4 py-2.5">
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={commitName}
          className="bg-surface-mid border border-line-strong rounded px-2 py-1 text-xs text-strong w-32" />
      </td>
      {showParty && (
        <td className="px-4 py-2.5">
          <input value={party} onChange={(e) => setParty(e.target.value)} onBlur={commitParty} placeholder="—"
            className="bg-surface-mid border border-line-strong rounded px-2 py-1 text-xs text-strong w-32" />
        </td>
      )}
      <td className="px-4 py-2.5">
        <select value={unit} onChange={(e) => { const v = e.target.value as "bbl" | "gallon"; setUnit(v); update({ unit: v }); }}
          className="bg-surface-mid border border-line-strong rounded px-2 py-1 text-xs text-strong">
          <option value="bbl">bbl</option>
          <option value="gallon">gallon</option>
        </select>
      </td>
      <td className="px-4 py-2.5 text-right">
        <input type="number" step="0.01" value={rateUsd} onChange={(e) => setRateUsd(e.target.value)} onBlur={commitRate}
          className="bg-surface-mid border border-line-strong rounded px-2 py-1 text-xs text-strong w-24 text-right" />
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
              ? "bg-success-surface/40 border-success-border text-success hover:bg-success-surface/60"
              : "bg-surface border-line-strong text-muted hover:text-body"
          }`}
        >
          {rate.is_active ? "Active" : "Inactive"}
        </button>
      </td>
    </tr>
  );
}

/**
 * Excise-rate table, shared between production Export Settings (all rows,
 * free-text receiving party) and Finance → Settings → Tax Filing (scoped to
 * one authority via `partyKey`, party column hidden since the authority is
 * fixed by page context).
 */
export default function ExciseRatesSection({ partyKey }: { partyKey?: string }) {
  const qc = useQueryClient();
  const { data: rates = [] } = useExciseTaxRatesQuery(partyKey);
  const { data: catalog } = useExportSquareCatalogQuery();
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftParty, setDraftParty] = useState("");
  const [draftUnit, setDraftUnit] = useState<"bbl" | "gallon">("bbl");
  const [draftRate, setDraftRate] = useState("");

  const showParty = !partyKey;
  const items = catalog?.items ?? [];

  async function refresh() {
    await qc.invalidateQueries({ queryKey: queryKeys.production.exciseTaxRates(partyKey) });
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
        party_key: partyKey,
      }),
    });
    setCreating(false);
    setDraftName(""); setDraftParty(""); setDraftUnit("bbl"); setDraftRate("");
    await refresh();
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-strong">Excise Tax Rates</h3>
        <button
          onClick={() => setCreating((c) => !c)}
          className="btn-primary"
        >
          {creating ? "Cancel" : "+ Add rate"}
        </button>
      </div>

      {creating && (
        <div className="flex items-end gap-2 mb-3 p-3 bg-surface/60 border border-line rounded">
          <input value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="Name"
            className="bg-surface-mid border border-line-strong rounded px-2 py-1 text-xs text-strong w-40" />
          {showParty && (
            <input value={draftParty} onChange={(e) => setDraftParty(e.target.value)} placeholder="Receiving party"
              className="bg-surface-mid border border-line-strong rounded px-2 py-1 text-xs text-strong w-40" />
          )}
          <select value={draftUnit} onChange={(e) => setDraftUnit(e.target.value as "bbl" | "gallon")}
            className="bg-surface-mid border border-line-strong rounded px-2 py-1 text-xs text-strong">
            <option value="bbl">bbl</option>
            <option value="gallon">gallon</option>
          </select>
          <input value={draftRate} onChange={(e) => setDraftRate(e.target.value)} placeholder="Rate (USD)" type="number" step="0.01"
            className="bg-surface-mid border border-line-strong rounded px-2 py-1 text-xs text-strong w-28" />
          <button onClick={create} className="btn-primary">
            Save
          </button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-surface/50 text-left">
              <th className="px-4 py-2.5 text-xs font-medium text-muted">Name</th>
              {showParty && <th className="px-4 py-2.5 text-xs font-medium text-muted">Receiving Party</th>}
              <th className="px-4 py-2.5 text-xs font-medium text-muted">Unit</th>
              <th className="px-4 py-2.5 text-xs font-medium text-muted text-right">Rate</th>
              <th className="px-4 py-2.5 text-xs font-medium text-muted">Square Mapping</th>
              <th className="px-4 py-2.5 text-xs font-medium text-muted">Status</th>
            </tr>
          </thead>
          <tbody>
            {rates.map((rate) => (
              <ExciseTaxRateRow key={rate.id} rate={rate} items={items} showParty={showParty} onSave={save} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
