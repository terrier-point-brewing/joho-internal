"use client";

import React, { useMemo, useState } from "react";
import { Modal, Field } from "./shared";
import { FORMATS, needsPaktech, needsTray, isDuplicateCombo, type VariationCombo } from "@/lib/production/packagingVariations";
import { buildCanVariationName } from "@/lib/production/bulkCanVariationNaming";
import type { PackagingItem, PackagingVariation, PackagingVariationFormat, ContractBrewingPartner } from "../types";

interface BaseForm {
  baseName: string;
  container_id: string;
  lid_id: string;
  is_labeled: boolean;
  label_id: string;
  partner_id: string;
}

const EMPTY_BASE: BaseForm = {
  baseName: "",
  container_id: "",
  lid_id: "",
  is_labeled: false,
  label_id: "",
  partner_id: "",
};

interface FormatRow {
  format: PackagingVariationFormat;
  checked: boolean;
  name: string;
  paktech_id: string;
  tray_id: string;
}

function buildRows(base: BaseForm, containerName: string): FormatRow[] {
  return FORMATS.map((f) => ({
    format: f.value,
    checked: false,
    name: buildCanVariationName({
      baseName: base.baseName,
      containerName,
      format: f.value,
      isLabeled: base.is_labeled,
    }),
    paktech_id: "",
    tray_id: "",
  }));
}

function rowCombo(row: FormatRow, base: BaseForm): VariationCombo {
  return {
    container_id: base.container_id,
    format: row.format,
    lid_id: base.lid_id || null,
    paktech_id: needsPaktech(row.format) ? (row.paktech_id || null) : null,
    tray_id: needsTray(row.format) ? (row.tray_id || null) : null,
    label_id: base.is_labeled ? (base.label_id || null) : null,
    partner_id: base.partner_id || null,
  };
}

function rowIsReady(row: FormatRow): boolean {
  if (needsPaktech(row.format)) return !!row.paktech_id;
  if (needsTray(row.format)) return !!row.tray_id;
  return true;
}

export default function BulkCanVariationModal({
  packaging,
  partners,
  variations,
  onClose,
  onCreated,
}: {
  packaging: PackagingItem[];
  partners: ContractBrewingPartner[];
  variations: PackagingVariation[];
  onClose: () => void;
  onCreated: () => Promise<void> | void;
}) {
  const containers = packaging.filter((p) => p.type === "can");
  const lids       = packaging.filter((p) => p.type === "lid");
  const paktechs   = packaging.filter((p) => p.type === "paktech");
  const trays      = packaging.filter((p) => p.type === "tray");
  const labels     = packaging.filter((p) => p.type === "label");

  const [step, setStep] = useState<"base" | "formats">("base");
  const [base, setBase] = useState<BaseForm>(EMPTY_BASE);
  const [rows, setRows] = useState<FormatRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const container = containers.find((c) => c.id === base.container_id) ?? null;

  const baseReady =
    base.baseName.trim() !== "" &&
    !!base.container_id &&
    !!base.lid_id &&
    (!base.is_labeled || !!base.label_id);

  const existingCombos = useMemo<VariationCombo[]>(
    () =>
      variations
        .filter((v) => v.container_id === base.container_id)
        .map((v) => ({
          container_id: v.container_id,
          format: v.format,
          lid_id: v.lid_id,
          paktech_id: v.paktech_id,
          tray_id: v.tray_id,
          label_id: v.label_id,
          partner_id: v.partner_id,
        })),
    [variations, base.container_id]
  );

  function goToFormats() {
    if (!container) return;
    setRows(buildRows(base, container.name));
    setError(null);
    setStep("formats");
  }

  function updateRow(format: PackagingVariationFormat, patch: Partial<FormatRow>) {
    setRows((rs) => rs.map((r) => (r.format === format ? { ...r, ...patch } : r)));
  }

  const readyRows = rows.filter((r) => r.checked && rowIsReady(r));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const items = readyRows.map((row) => ({
        container_id: base.container_id,
        format: row.format,
        lid_id: base.lid_id,
        paktech_id: needsPaktech(row.format) ? (row.paktech_id || null) : null,
        tray_id: needsTray(row.format) ? (row.tray_id || null) : null,
        label_id: base.is_labeled ? (base.label_id || null) : null,
        partner_id: base.partner_id || null,
        name: row.name,
      }));
      const res = await fetch("/api/production/packaging-variations/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      await onCreated();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Bulk Create Variations" onClose={onClose} extraWide>
      {step === "base" ? (
        <div className="space-y-3">
          <Field label="Base Name" required>
            <input
              className="inp w-full"
              value={base.baseName}
              onChange={(e) => setBase((b) => ({ ...b, baseName: e.target.value }))}
              placeholder="e.g. CBC Pumpkin Reaper Ale"
            />
          </Field>
          <Field label="Container" required>
            <select className="inp w-full" value={base.container_id} onChange={(e) => setBase((b) => ({ ...b, container_id: e.target.value }))}>
              <option value="">Select…</option>
              {containers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Lid" required>
            <select className="inp w-full" value={base.lid_id} onChange={(e) => setBase((b) => ({ ...b, lid_id: e.target.value }))}>
              <option value="">Select lid…</option>
              {lids.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
          <Field label="Can Type" required>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="bulk_can_type" checked={!base.is_labeled} onChange={() => setBase((b) => ({ ...b, is_labeled: false, label_id: "" }))} />
                <span className="text-sm text-body">Printed Can</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="bulk_can_type" checked={base.is_labeled} onChange={() => setBase((b) => ({ ...b, is_labeled: true }))} />
                <span className="text-sm text-body">Labeled Can</span>
              </label>
            </div>
          </Field>
          {base.is_labeled && (
            <Field label="Label" required>
              <select className="inp w-full" value={base.label_id} onChange={(e) => setBase((b) => ({ ...b, label_id: e.target.value }))}>
                <option value="">Select label…</option>
                {labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </Field>
          )}
          <Field label="Partner" hint="Leave blank for a generic variation available to everyone">
            <select className="inp w-full" value={base.partner_id} onChange={(e) => setBase((b) => ({ ...b, partner_id: e.target.value }))}>
              <option value="">Generic (no partner)</option>
              {partners.map((p) => <option key={p.id} value={p.id}>{p.company_name}</option>)}
            </select>
          </Field>
          <div className="flex justify-end gap-2 pt-3 border-t border-line mt-4">
            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
            <button type="button" onClick={goToFormats} disabled={!baseReady} className="btn-primary">Next</button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface/50 text-left">
                  <th className="px-3 py-2.5 text-xs font-medium text-muted"></th>
                  <th className="px-3 py-2.5 text-xs font-medium text-muted">Name</th>
                  <th className="px-3 py-2.5 text-xs font-medium text-muted">Extra item</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const duplicate = isDuplicateCombo(rowCombo(row, base), existingCombos);
                  const ready = rowIsReady(row);
                  return (
                    <tr key={row.format} className="border-b border-line/60">
                      <td className="px-3 py-2.5 align-top">
                        <input type="checkbox" checked={row.checked} onChange={(e) => updateRow(row.format, { checked: e.target.checked })} />
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        <input className="inp w-full mb-1" value={row.name} onChange={(e) => updateRow(row.format, { name: e.target.value })} />
                        <div className="flex gap-2">
                          {duplicate && (
                            <span className="text-xs px-1.5 py-0.5 rounded border border-line-subtle bg-surface-mid/60 text-muted">Already exists</span>
                          )}
                          {row.checked && !ready && (
                            <span className="text-xs text-danger">
                              Select a {needsPaktech(row.format) ? "PakTech" : "Tray"} to include this format
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        {needsPaktech(row.format) && (
                          <select className="inp w-full" value={row.paktech_id} onChange={(e) => updateRow(row.format, { paktech_id: e.target.value })}>
                            <option value="">Select PakTech…</option>
                            {paktechs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                        )}
                        {needsTray(row.format) && (
                          <select className="inp w-full" value={row.tray_id} onChange={(e) => updateRow(row.format, { tray_id: e.target.value })}>
                            <option value="">Select Tray…</option>
                            {trays.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                          </select>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex items-center justify-between gap-2 pt-3 border-t border-line mt-4">
            <button type="button" onClick={() => setStep("base")} className="btn-secondary">Back</button>
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
              <button type="submit" disabled={submitting || readyRows.length === 0} className="btn-primary">
                {submitting ? "Creating…" : `Create ${readyRows.length} Variation${readyRows.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        </form>
      )}
    </Modal>
  );
}
