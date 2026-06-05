"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, Field } from "./shared";
import { useBatchesQuery, fetchJson } from "../hooks/queries";

const EXPORTS_KEY = ["production", "exports"] as const;

// ─── Types ───────────────────────────────────────────────────────────────────

export type ExportChannel = "taproom" | "distribution" | "contract_brewing";

interface BatchExport {
  id: string;
  batch_id: string;
  channel: ExportChannel;
  recipient_id: string | null;
  recipient_name: string | null;
  product_type: "keg" | "can" | "growler" | "other";
  quantity: number;
  unit: string;
  volume_bbl: number | null;
  notes: string | null;
  // Square API fields — populated when synced (taproom channel only)
  square_catalog_item_id: string | null;
  square_location_id: string | null;
  square_synced_at: string | null;
  exported_at: string;
  brew_batches: { id: string; beer_name: string; batch_number: number } | null;
}

const CHANNEL_TABS: { key: ExportChannel; label: string; description: string }[] = [
  {
    key: "taproom",
    label: "Taproom",
    description: "Product pushed to taproom inventory. Will sync with Square API to update item stock at the taproom location.",
  },
  {
    key: "distribution",
    label: "Distribution",
    description: "Product shipped to distribution partners for retail/wholesale.",
  },
  {
    key: "contract_brewing",
    label: "Contract Brewing",
    description: "Product delivered to contract brewing clients.",
  },
];

const PRODUCT_TYPES = ["keg", "can", "growler", "other"] as const;
const UNITS = ["units", "cases", "bbl"];

interface ExportForm {
  batch_id: string;
  product_type: "keg" | "can" | "growler" | "other";
  quantity: string;
  unit: string;
  recipient_name: string;
  notes: string;
  volume_bbl: string;
}

function blank(): ExportForm {
  return { batch_id: "", product_type: "keg", quantity: "", unit: "units", recipient_name: "", notes: "", volume_bbl: "" };
}

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function ExportTab() {
  const qc = useQueryClient();
  const { data: batches = [] } = useBatchesQuery();
  const { data: exports = [] } = useQuery({
    queryKey: EXPORTS_KEY,
    queryFn: () => fetchJson<BatchExport[]>("/api/production/exports"),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: EXPORTS_KEY });

  const [channel, setChannel] = useState<ExportChannel>("taproom");
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ExportForm>(blank());
  const [saving, setSaving] = useState(false);

  const channelExports = exports.filter(e => e.channel === channel);
  const channelMeta = CHANNEL_TABS.find(c => c.key === channel)!;

  function openNew() {
    setForm(blank());
    setEditingId(null);
    setShowModal(true);
  }

  function openEdit(e: BatchExport) {
    setForm({
      batch_id: e.batch_id,
      product_type: e.product_type,
      quantity: String(e.quantity),
      unit: e.unit,
      recipient_name: e.recipient_name ?? "",
      notes: e.notes ?? "",
      volume_bbl: e.volume_bbl != null ? String(e.volume_bbl) : "",
    });
    setEditingId(e.id);
    setShowModal(true);
  }

  async function save() {
    setSaving(true);
    const payload = {
      batch_id: form.batch_id,
      channel,
      recipient_name: form.recipient_name || null,
      product_type: form.product_type,
      quantity: Number(form.quantity),
      unit: form.unit,
      volume_bbl: form.volume_bbl ? Number(form.volume_bbl) : null,
      notes: form.notes || null,
    };
    const url = editingId ? `/api/production/exports/${editingId}` : "/api/production/exports";
    const method = editingId ? "PATCH" : "POST";
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (res.ok) { await refresh(); setShowModal(false); }
    setSaving(false);
  }

  async function remove(id: string) {
    if (!confirm("Delete this export record?")) return;
    await fetch(`/api/production/exports/${id}`, { method: "DELETE" });
    await refresh();
  }

  const f = (k: string, v: string) => setForm(prev => ({ ...prev, [k]: v }));

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-medium text-zinc-100">Export</h2>
          <p className="text-sm text-zinc-500 mt-0.5">Track finished product leaving the brewery through each distribution channel</p>
        </div>
        <button onClick={openNew} className="btn-amber">+ Log Export</button>
      </div>

      {/* Channel subtab bar */}
      <div className="flex gap-1 mb-6 border-b border-zinc-800">
        {CHANNEL_TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setChannel(key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              channel === key
                ? "border-amber-500 text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {label}
            <span className="ml-1.5 text-xs text-zinc-600">
              ({exports.filter(e => e.channel === key).length})
            </span>
          </button>
        ))}
      </div>

      {/* Channel description */}
      <p className="text-xs text-zinc-600 mb-4">{channelMeta.description}</p>

      {/* Square sync notice for taproom */}
      {channel === "taproom" && (
        <div className="mb-4 px-3 py-2 bg-zinc-800/60 border border-zinc-700 rounded text-xs text-zinc-500 flex items-center gap-2">
          <span className="text-zinc-600">■</span>
          Square API integration pending — taproom exports will automatically update Square inventory when connected.
        </div>
      )}

      {/* Exports table */}
      {channelExports.length === 0 ? (
        <p className="text-sm text-zinc-600">No {channelMeta.label.toLowerCase()} exports recorded yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Date</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Batch</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Product</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Qty</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Volume (BBL)</th>
                {channel !== "taproom" && <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Recipient</th>}
                {channel === "taproom" && <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Square Sync</th>}
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Notes</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {channelExports.map(e => (
                <tr key={e.id} className="border-b border-zinc-800 last:border-0 hover:bg-zinc-900/30">
                  <td className="px-4 py-2.5 text-zinc-400 whitespace-nowrap">{fmt(e.exported_at)}</td>
                  <td className="px-4 py-2.5 text-zinc-200">
                    {e.brew_batches ? `#${e.brew_batches.batch_number} ${e.brew_batches.beer_name}` : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="px-1.5 py-0.5 rounded text-xs bg-zinc-800 text-zinc-300 capitalize">{e.product_type}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right text-zinc-200">{e.quantity} {e.unit}</td>
                  <td className="px-4 py-2.5 text-right text-zinc-400">{e.volume_bbl ?? "—"}</td>
                  {channel !== "taproom" && <td className="px-4 py-2.5 text-zinc-400">{e.recipient_name ?? "—"}</td>}
                  {channel === "taproom" && (
                    <td className="px-4 py-2.5">
                      {e.square_synced_at
                        ? <span className="text-xs text-emerald-400">Synced {fmt(e.square_synced_at)}</span>
                        : <span className="text-xs text-zinc-600">Not synced</span>}
                    </td>
                  )}
                  <td className="px-4 py-2.5 text-zinc-500 text-xs">{e.notes ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex gap-2">
                      <button onClick={() => openEdit(e)} className="text-xs text-zinc-500 hover:text-zinc-300">Edit</button>
                      <button onClick={() => remove(e.id)} className="text-xs text-zinc-600 hover:text-red-400">Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <Modal title={editingId ? "Edit Export Record" : "Log Export"} onClose={() => setShowModal(false)}>
          <Field label="Batch">
            <select className="inp" value={form.batch_id} onChange={e => f("batch_id", e.target.value)}>
              <option value="">— Select batch —</option>
              {batches.map(b => <option key={b.id} value={b.id}>#{b.batch_number} {b.beer_name}</option>)}
            </select>
          </Field>
          <Field label="Product Type">
            <select className="inp" value={form.product_type} onChange={e => f("product_type", e.target.value)}>
              {PRODUCT_TYPES.map(t => <option key={t} value={t} className="capitalize">{t}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Quantity">
              <input type="number" min="0" step="0.01" className="inp" value={form.quantity} onChange={e => f("quantity", e.target.value)} />
            </Field>
            <Field label="Unit">
              <select className="inp" value={form.unit} onChange={e => f("unit", e.target.value)}>
                {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Volume (BBL, optional)">
            <input type="number" min="0" step="0.01" className="inp" value={form.volume_bbl ?? ""} onChange={e => f("volume_bbl", e.target.value)} />
          </Field>
          {channel !== "taproom" && (
            <Field label="Recipient">
              <input type="text" className="inp" value={form.recipient_name ?? ""} onChange={e => f("recipient_name", e.target.value)} placeholder="Company or person name" />
            </Field>
          )}
          <Field label="Notes">
            <input type="text" className="inp" value={form.notes ?? ""} onChange={e => f("notes", e.target.value)} placeholder="Optional" />
          </Field>
          <button
            onClick={save}
            disabled={saving || !form.batch_id || !form.quantity}
            className="w-full mt-2 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-medium rounded"
          >
            {saving ? "Saving…" : editingId ? "Save Changes" : "Log Export"}
          </button>
        </Modal>
      )}
    </>
  );
}
