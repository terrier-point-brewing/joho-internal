"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import {
  useExportServiceMappingsQuery,
  useContractPartnersQuery,
  useExportSquareCatalogQuery,
  useDepositInvoiceDueDaysQuery,
} from "../hooks/queries";
import type { ExportServiceMapping } from "../types";
import { SquareCatalogSelect } from "@/app/components/SquareCatalogSelect";
import { PartnerOverridePicker } from "./ExportSettingsPanel";

function IngredientDepositMappingSection() {
  const { data: mappings = [] } = useExportServiceMappingsQuery();
  const { data: partners = [] } = useContractPartnersQuery();
  const { data: catalog } = useExportSquareCatalogQuery();
  const qc = useQueryClient();
  const items = catalog?.items ?? [];

  const rows = mappings.filter((m) => m.service_type === "ingredient_deposit");
  const defaultRow = rows.find((m) => m.partner_id === null) ?? null;
  const overrideRows = rows.filter((m) => m.partner_id !== null);

  async function upsert(existing: ExportServiceMapping | null, partnerId: string | null, itemId: string | null, variationId: string | null) {
    await fetch("/api/production/export-settings/service-mappings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: existing?.id,
        service_type: "ingredient_deposit",
        partner_id: partnerId,
        display_name: "Ingredient Deposit",
        square_catalog_item_id: itemId,
        square_catalog_variation_id: variationId,
      }),
    });
    await qc.invalidateQueries({ queryKey: queryKeys.production.exportServiceMappings() });
  }

  return (
    <section>
      <h3 className="text-sm font-medium text-zinc-200 mb-2">Ingredient Deposit — Square Item</h3>
      <p className="text-xs text-zinc-600 mb-2">Default Square catalog item for deposit invoices, with optional per-partner overrides.</p>
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

function DepositInvoiceTermsSection() {
  const { data } = useDepositInvoiceDueDaysQuery();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);

  const days = data?.days ?? 30;

  async function save() {
    const value = Number(draft || days);
    if (!Number.isInteger(value) || value < 1 || value > 365) return;
    setSaving(true);
    await fetch("/api/production/deposit-settings/invoice-due-days", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days: value }),
    });
    setDraft("");
    setSaving(false);
    await qc.invalidateQueries({ queryKey: queryKeys.production.depositInvoiceDueDays() });
  }

  return (
    <section>
      <h3 className="text-sm font-medium text-zinc-200 mb-2">Default Deposit Net Terms</h3>
      <p className="text-xs text-zinc-600 mb-2">
        Days until payment is due on a generated deposit invoice, used when a partner has no override set (set per-partner in the Partners tab).
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

export default function DepositSettingsPanel() {
  return (
    <div className="flex flex-col gap-8">
      <IngredientDepositMappingSection />
      <DepositInvoiceTermsSection />
    </div>
  );
}
