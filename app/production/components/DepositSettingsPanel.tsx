"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import {
  useExportServiceMappingsQuery,
  useContractPartnersQuery,
  useExportSquareCatalogQuery,
  useDepositInvoiceDueDaysQuery,
  useDepositPackagingYieldQuery,
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
      <h3 className="text-sm font-medium text-strong mb-2">Ingredient Deposit — Square Item</h3>
      <p className="text-xs text-faint mb-2">Default Square catalog item for deposit invoices, with optional per-partner overrides.</p>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted italic w-28">Default</span>
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
              <span className="text-xs text-body w-28 truncate">{partner?.company_name ?? "Unknown partner"}</span>
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
      <h3 className="text-sm font-medium text-strong mb-2">Deposit Invoice Net Terms</h3>
      <p className="text-xs text-faint mb-2">
        Days from the draft date until a deposit invoice is due. Applies to every partner.
      </p>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={1}
          max={365}
          value={draft !== "" ? draft : days}
          onChange={(e) => setDraft(e.target.value)}
          className="inp-sm w-20"
        />
        <span className="text-xs text-muted">days</span>
        <button onClick={save} disabled={saving} className="btn-primary">
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </section>
  );
}

/**
 * The house packaging-yield rule. Not a per-invoice value — Settings holds the
 * rule, the deposit calculation applies it.
 *
 * The copy has to spell out which way to err, because the direction reads
 * backwards: the factor is a denominator, so a HIGHER percentage charges LESS.
 * Nobody guesses that from the label.
 */
function PackagingYieldSection() {
  const { data } = useDepositPackagingYieldQuery();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);

  const pct = data?.pct ?? 90;

  async function save() {
    const value = Number(draft || pct);
    if (!Number.isFinite(value) || value < 50 || value > 100) return;
    setSaving(true);
    await fetch("/api/production/deposit-settings/packaging-yield", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pct: value }),
    });
    setDraft("");
    setSaving(false);
    await qc.invalidateQueries({ queryKey: queryKeys.production.depositPackagingYield() });
  }

  return (
    <section>
      <h3 className="text-sm font-medium text-strong mb-2">Expected Packaging Yield</h3>
      <p className="text-xs text-faint mb-2">
        How much of the beer still in tank is expected to survive packaging. An ingredient deposit divides a
        shipment by what its batch will yield, and beer that hasn&rsquo;t been packaged yet still has its loss
        ahead of it — this shrinks it before it counts. Set it at, or a touch above, the yield you actually get:
        a higher number charges less, which is recoverable, while a number below your real yield bills a partner
        for grain that was never theirs.
      </p>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={50}
          max={100}
          step={0.5}
          value={draft !== "" ? draft : pct}
          onChange={(e) => setDraft(e.target.value)}
          className="inp-sm w-20"
        />
        <span className="text-xs text-muted">%</span>
        <button onClick={save} disabled={saving} className="btn-primary">
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
      <PackagingYieldSection />
      <DepositInvoiceTermsSection />
    </div>
  );
}
