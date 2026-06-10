"use client";

import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import {
  Recipe, ContractBrewingPartner, ContractBrewingRequest,
  ContractRequestStatus, CommitmentChannel,
} from "../../types";
import { fmtDateLong } from "@/lib/utils/formatting";
import { Modal, Field, ModalActions } from "../shared";
import { fetchJson, usePackagingQuery } from "../../hooks/queries";

const STATUS_META: Record<ContractRequestStatus, { label: string; cls: string }> = {
  open:        { label: "Open",        cls: "bg-amber-900/50 text-amber-400 border-amber-800" },
  in_progress: { label: "In Progress", cls: "bg-blue-900/50 text-blue-400 border-blue-800" },
  fulfilled:   { label: "Fulfilled",   cls: "bg-green-900/50 text-green-400 border-green-800" },
  cancelled:   { label: "Cancelled",   cls: "bg-red-900/40 text-red-400 border-red-800" },
};

const CHANNEL_META: Record<CommitmentChannel, { label: string; cls: string }> = {
  distribution:     { label: "Distribution",     cls: "bg-blue-900/40 text-blue-300 border-blue-800" },
  contract_brewing: { label: "Contract Brewing", cls: "bg-purple-900/40 text-purple-300 border-purple-800" },
};

function StatusBadge({ status }: { status: ContractRequestStatus }) {
  const m = STATUS_META[status] ?? STATUS_META.open;
  return <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${m.cls}`}>{m.label}</span>;
}

function ChannelBadge({ channel }: { channel: CommitmentChannel }) {
  const m = CHANNEL_META[channel] ?? CHANNEL_META.contract_brewing;
  return <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${m.cls}`}>{m.label}</span>;
}

interface FormState {
  channel: CommitmentChannel;
  recipe_id: string;
  partner_id: string;
  volume_bbl: string;
  desired_delivery_date: string;
  cadence: "one_time" | "recurring";
  recurrence: "weekly" | "biweekly" | "monthly";
  start_date: string;
  end_date: string;
  packaging_item_id: string;
  packaging_qty: string;
  status: ContractRequestStatus;
  notes: string;
  received_on: string;
  locked_on: string;
}

const FORM_EMPTY: FormState = {
  channel: "contract_brewing",
  recipe_id: "", partner_id: "", volume_bbl: "",
  desired_delivery_date: "", cadence: "one_time",
  recurrence: "weekly", start_date: "", end_date: "",
  packaging_item_id: "", packaging_qty: "",
  status: "open", notes: "",
  received_on: "", locked_on: "",
};

function CommitmentModal({
  recipes, partners, existing, onClose, onDone,
}: {
  recipes: Recipe[];
  partners: ContractBrewingPartner[];
  existing?: ContractBrewingRequest;
  onClose: () => void;
  onDone: () => void;
}) {
  const isEdit = !!existing;
  const { data: packaging = [] } = usePackagingQuery();
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState<FormState>(existing ? {
    channel: existing.channel,
    recipe_id: existing.recipe_id ?? "",
    partner_id: existing.partner_id ?? "",
    volume_bbl: String(existing.volume_bbl),
    desired_delivery_date: existing.desired_delivery_date ?? "",
    cadence: existing.cadence,
    recurrence: existing.recurrence ?? "weekly",
    start_date: existing.start_date ?? "",
    end_date: existing.end_date ?? "",
    packaging_item_id: existing.packaging_item_id ?? "",
    packaging_qty: existing.packaging_qty != null ? String(existing.packaging_qty) : "",
    status: existing.status,
    notes: existing.notes ?? "",
    received_on: existing.received_on ?? "",
    locked_on: existing.locked_on ?? "",
  } : FORM_EMPTY);
  const set = (k: keyof FormState, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const kegs = packaging.filter((p) => p.type === "keg");
  const cans = packaging.filter((p) => p.type === "can");

  const isDistribution = form.channel === "distribution";
  const isRecurring = isDistribution && form.cadence === "recurring";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.recipe_id) { alert("Please select a recipe."); return; }
    setSubmitting(true);
    try {
      const beer_style = recipes.find((r) => r.id === form.recipe_id)?.beer_name ?? "";
      const body = {
        channel: form.channel,
        recipe_id: form.recipe_id,
        beer_style,
        partner_id: form.partner_id || null,
        volume_bbl: parseFloat(form.volume_bbl),
        desired_delivery_date: !isRecurring ? (form.desired_delivery_date || null) : null,
        cadence: isDistribution ? form.cadence : "one_time",
        recurrence: isRecurring ? form.recurrence : null,
        start_date: isRecurring ? (form.start_date || null) : null,
        end_date: isRecurring ? (form.end_date || null) : null,
        packaging_item_id: form.packaging_item_id || null,
        packaging_qty: form.packaging_qty ? parseFloat(form.packaging_qty) : null,
        status: form.status,
        notes: form.notes || null,
        received_on: form.received_on || null,
        locked_on: form.locked_on || null,
      };
      const url = isEdit ? `/api/production/contract-requests?id=${existing!.id}` : "/api/production/contract-requests";
      const res = await fetch(url, { method: isEdit ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      onDone(); onClose();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Error");
    } finally { setSubmitting(false); }
  }

  return (
    <Modal title={isEdit ? "Edit Commitment" : "New Commitment"} onClose={onClose} wide>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Channel selector */}
        <Field label="Channel" required>
          <div className="grid grid-cols-2 gap-2">
            {(["contract_brewing", "distribution"] as CommitmentChannel[]).map((c) => (
              <button key={c} type="button" onClick={() => set("channel", c)}
                className={`px-3 py-2 rounded border text-sm transition-colors ${form.channel === c ? "border-amber-600 bg-amber-900/30 text-amber-300" : "border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-500"}`}>
                {CHANNEL_META[c].label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Recipe" required>
          <select className="inp" value={form.recipe_id} onChange={(e) => set("recipe_id", e.target.value)} required>
            <option value="">— select a recipe —</option>
            {recipes.map((r) => <option key={r.id} value={r.id}>{r.beer_name}</option>)}
          </select>
        </Field>

        <Field label={isDistribution ? "Distributor (Partner)" : "Requestor (Partner)"}>
          <select className="inp" value={form.partner_id} onChange={(e) => set("partner_id", e.target.value)}>
            <option value="">— none —</option>
            {partners.map((p) => <option key={p.id} value={p.id}>{p.company_name}</option>)}
          </select>
        </Field>

        <Field label="Volume (BBL)" required>
          <input type="number" step="0.01" min="0" className="inp" required
            value={form.volume_bbl} onChange={(e) => set("volume_bbl", e.target.value)} />
        </Field>

        {/* Scheduling: cadence for distribution, single date otherwise */}
        {isDistribution ? (
          <>
            <Field label="Cadence" required>
              <div className="grid grid-cols-2 gap-2">
                {(["one_time", "recurring"] as const).map((c) => (
                  <button key={c} type="button" onClick={() => set("cadence", c)}
                    className={`px-3 py-2 rounded border text-sm transition-colors ${form.cadence === c ? "border-amber-600 bg-amber-900/30 text-amber-300" : "border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-500"}`}>
                    {c === "one_time" ? "One-time" : "Recurring"}
                  </button>
                ))}
              </div>
            </Field>
            {isRecurring ? (
              <div className="grid grid-cols-3 gap-3">
                <Field label="Start Date" required>
                  <input type="date" className="inp" required value={form.start_date}
                    onChange={(e) => set("start_date", e.target.value)} />
                </Field>
                <Field label="Frequency">
                  <select className="inp" value={form.recurrence}
                    onChange={(e) => set("recurrence", e.target.value as typeof form.recurrence)}>
                    <option value="weekly">Weekly</option>
                    <option value="biweekly">Biweekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </Field>
                <Field label="End Date">
                  <input type="date" className="inp" value={form.end_date}
                    onChange={(e) => set("end_date", e.target.value)} />
                </Field>
              </div>
            ) : (
              <Field label="Delivery Date" required>
                <input type="date" className="inp" required value={form.desired_delivery_date}
                  onChange={(e) => set("desired_delivery_date", e.target.value)} />
              </Field>
            )}
          </>
        ) : (
          <Field label="Desired Delivery">
            <input type="date" className="inp" value={form.desired_delivery_date}
              onChange={(e) => set("desired_delivery_date", e.target.value)} />
          </Field>
        )}

        {/* Packaging preference */}
        <div className="rounded border border-zinc-800 px-3 py-3 space-y-3">
          <p className="text-xs font-medium text-zinc-400">Packaging Preference</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Container type">
              <select className="inp" value={form.packaging_item_id} onChange={(e) => set("packaging_item_id", e.target.value)}>
                <option value="">— not specified —</option>
                {kegs.length > 0 && (
                  <optgroup label="Kegs">
                    {kegs.map((p) => <option key={p.id} value={p.id}>{p.name}{p.volume_fl_oz ? ` (${p.volume_fl_oz} fl oz)` : ""}</option>)}
                  </optgroup>
                )}
                {cans.length > 0 && (
                  <optgroup label="Cans">
                    {cans.map((p) => <option key={p.id} value={p.id}>{p.name}{p.volume_fl_oz ? ` (${p.volume_fl_oz} fl oz)` : ""}</option>)}
                  </optgroup>
                )}
              </select>
            </Field>
            <Field label="Quantity">
              <input type="number" step="1" min="0" className="inp" placeholder="# of containers"
                value={form.packaging_qty} onChange={(e) => set("packaging_qty", e.target.value)} />
            </Field>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Status">
            <select className="inp" value={form.status} onChange={(e) => set("status", e.target.value as ContractRequestStatus)}>
              {(["open", "in_progress", "fulfilled", "cancelled"] as ContractRequestStatus[]).map((s) => (
                <option key={s} value={s}>{STATUS_META[s].label}</option>
              ))}
            </select>
          </Field>
          <Field label="Notes">
            <input className="inp" value={form.notes} onChange={(e) => set("notes", e.target.value)} />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Received On">
            <input type="date" className="inp" value={form.received_on}
              onChange={(e) => set("received_on", e.target.value)} />
          </Field>
          <Field label="Locked On">
            <input type="date" className="inp" value={form.locked_on}
              onChange={(e) => set("locked_on", e.target.value)} />
          </Field>
        </div>

        <ModalActions submitting={submitting} onCancel={onClose} label={isEdit ? "Save Changes" : "Create"} />
      </form>
    </Modal>
  );
}

export default function CommitmentsTab({ recipes, partners }: { recipes: Recipe[]; partners: ContractBrewingPartner[] }) {
  const qc = useQueryClient();
  const { data: rows = [] } = useQuery({
    queryKey: queryKeys.production.commitments(),
    queryFn: () => fetchJson<ContractBrewingRequest[]>("/api/production/contract-requests"),
  });
  const load = () => qc.invalidateQueries({ queryKey: queryKeys.production.commitments() });
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<ContractBrewingRequest | null>(null);
  const [channelFilter, setChannelFilter] = useState<CommitmentChannel | "all">("all");

  async function handleDelete(id: string) {
    if (!confirm("Delete this commitment?")) return;
    const r = await fetch(`/api/production/contract-requests?id=${id}`, { method: "DELETE" });
    if (r.ok) load();
  }

  function pkgLabel(q: ContractBrewingRequest): string {
    if (!q.packaging_item_id || !q.packaging_items) return "—";
    const qty = q.packaging_qty != null ? `${q.packaging_qty} × ` : "";
    return `${qty}${q.packaging_items.name}`;
  }

  function scheduleLabel(q: ContractBrewingRequest): string {
    if (q.cadence === "recurring") {
      const freq = q.recurrence ?? "—";
      const from = q.start_date ? fmtDateLong(q.start_date) : "—";
      const to = q.end_date ? ` → ${fmtDateLong(q.end_date)}` : "";
      return `${freq.charAt(0).toUpperCase() + freq.slice(1)} from ${from}${to}`;
    }
    return q.desired_delivery_date ? fmtDateLong(q.desired_delivery_date) : "—";
  }

  const filtered = channelFilter === "all" ? rows : rows.filter((r) => r.channel === channelFilter);

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <div className="flex items-center gap-3">
          <p className="text-sm text-zinc-500">Distribution allocations and contract brewing requests. All are outflows from cold storage.</p>
          <div className="flex gap-1">
            {(["all", "distribution", "contract_brewing"] as const).map((f) => (
              <button key={f} onClick={() => setChannelFilter(f)}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors border ${channelFilter === f ? "border-amber-600 bg-amber-900/30 text-amber-300" : "border-zinc-700 text-zinc-500 hover:text-zinc-300"}`}>
                {f === "all" ? "All" : CHANNEL_META[f].label}
              </button>
            ))}
          </div>
        </div>
        <button onClick={() => setShowModal(true)} className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium rounded transition-colors">+ New</button>
      </div>

      {filtered.length === 0 ? (
        <p className="text-zinc-600 text-sm py-10 text-center">No commitments recorded yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                {["Channel", "Style", "Partner", "Volume", "Packaging Pref.", "Desired Delivery On", "Received On", "Last Edited", "Locked On", "Status", "Notes", ""].map((h, i) => (
                  <th key={i} className="px-4 py-2.5 text-xs font-medium text-zinc-500 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((q, i) => (
                <tr key={q.id} className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""}`}>
                  <td className="px-4 py-2.5"><ChannelBadge channel={q.channel} /></td>
                  <td className="px-4 py-2.5 text-zinc-100 font-medium">{q.beer_style}</td>
                  <td className="px-4 py-2.5 text-zinc-400">{q.contract_brewing_partners?.company_name ?? "—"}</td>
                  <td className="px-4 py-2.5 text-zinc-300 tabular-nums">{Number(q.volume_bbl)} BBL</td>
                  <td className="px-4 py-2.5 text-zinc-400 text-xs">{pkgLabel(q)}</td>
                  <td className="px-4 py-2.5 text-zinc-400 text-xs whitespace-nowrap">{scheduleLabel(q)}</td>
                  <td className="px-4 py-2.5 text-zinc-500 text-xs whitespace-nowrap">{q.received_on ? fmtDateLong(q.received_on) : "—"}</td>
                  <td className="px-4 py-2.5 text-zinc-500 text-xs whitespace-nowrap">{q.last_edited_on ? fmtDateLong(q.last_edited_on.slice(0, 10)) : "—"}</td>
                  <td className="px-4 py-2.5 text-zinc-500 text-xs whitespace-nowrap">{q.locked_on ? fmtDateLong(q.locked_on) : "—"}</td>
                  <td className="px-4 py-2.5"><StatusBadge status={q.status} /></td>
                  <td className="px-4 py-2.5 text-zinc-500 text-xs max-w-[160px] truncate">{q.notes ?? "—"}</td>
                  <td className="px-4 py-2.5 flex items-center gap-3">
                    <button onClick={() => setEditing(q)} className="text-xs text-zinc-400 hover:text-zinc-200">Edit</button>
                    <button onClick={() => handleDelete(q.id)} className="text-xs text-red-400/80 hover:text-red-400">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && <CommitmentModal recipes={recipes} partners={partners} onClose={() => setShowModal(false)} onDone={load} />}
      {editing && <CommitmentModal recipes={recipes} partners={partners} existing={editing} onClose={() => setEditing(null)} onDone={load} />}
    </div>
  );
}
