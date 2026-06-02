"use client";

import { useState, useEffect, useCallback } from "react";
import { ContractBrewingPartner, Supplier } from "../types";
import { Modal, Field, ModalActions } from "./shared";

type PartnerKind = "contract" | "supplier";

const PARTNER_EMPTY = {
  company_name: "",
  first_name: "",
  last_name: "",
  phone: "",
  address: "",
  email: "",
  notes: "",
};

function partnerApiBase(kind: PartnerKind) {
  return kind === "contract" ? "/api/partners/contract-brewing" : "/api/partners/suppliers";
}

export default function PartnersTab() {
  const [kind, setKind] = useState<PartnerKind>("contract");
  const [contractPartners, setContractPartners] = useState<ContractBrewingPartner[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);

  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(PARTNER_EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadContracts = useCallback(async () => {
    const r = await fetch("/api/partners/contract-brewing");
    if (r.ok) setContractPartners(await r.json());
  }, []);

  const loadSuppliers = useCallback(async () => {
    const r = await fetch("/api/partners/suppliers");
    if (r.ok) setSuppliers(await r.json());
  }, []);

  useEffect(() => { loadContracts(); loadSuppliers(); }, [loadContracts, loadSuppliers]);

  const records = kind === "contract" ? contractPartners : suppliers;

  function openNew() {
    setForm(PARTNER_EMPTY);
    setEditingId(null);
    setShowModal(true);
  }

  function openEdit(p: ContractBrewingPartner | Supplier) {
    setForm({
      company_name: p.company_name,
      first_name:   p.first_name  ?? "",
      last_name:    p.last_name   ?? "",
      phone:        p.phone       ?? "",
      address:      p.address     ?? "",
      email:        p.email       ?? "",
      notes:        p.notes       ?? "",
    });
    setEditingId(p.id);
    setShowModal(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    const base = partnerApiBase(kind);
    try {
      const payload = {
        company_name: form.company_name,
        first_name:   form.first_name  || null,
        last_name:    form.last_name   || null,
        phone:        form.phone       || null,
        address:      form.address     || null,
        email:        form.email       || null,
        notes:        form.notes       || null,
      };
      const res = editingId
        ? await fetch(`${base}/${editingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        : await fetch(base,                   { method: "POST",  headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setShowModal(false);
      kind === "contract" ? await loadContracts() : await loadSuppliers();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    await fetch(`${partnerApiBase(kind)}/${id}`, { method: "DELETE" });
    kind === "contract" ? await loadContracts() : await loadSuppliers();
  }

  const kindLabel = kind === "contract" ? "Contract Brewing Partner" : "Supplier";

  return (
    <>
      {/* Header + kind switcher */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-medium text-zinc-100">Partners</h2>
          <p className="text-sm text-zinc-500 mt-0.5">Contract brewing partners and ingredient/packaging suppliers</p>
        </div>
        <button onClick={openNew} className="btn-amber">+ New {kindLabel}</button>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 mb-5 border-b border-zinc-800">
        {(["contract", "supplier"] as PartnerKind[]).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              kind === k
                ? "border-amber-500 text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {k === "contract" ? "Contract Brewing" : "Suppliers"}
            <span className="ml-1.5 text-xs text-zinc-600">
              ({k === "contract" ? contractPartners.length : suppliers.length})
            </span>
          </button>
        ))}
      </div>

      {/* Records table */}
      {records.length === 0 ? (
        <p className="text-zinc-600 text-sm">No {kindLabel.toLowerCase()}s yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Company</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Contact</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Email</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Phone</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Address</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500"></th>
              </tr>
            </thead>
            <tbody>
              {records.map((p, i) => (
                <tr key={p.id} className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""}`}>
                  <td className="px-4 py-2.5 text-zinc-100 font-medium">{p.company_name}</td>
                  <td className="px-4 py-2.5 text-zinc-400">
                    {[p.first_name, p.last_name].filter(Boolean).join(" ") || <span className="text-zinc-700">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-400">
                    {p.email ? <a href={`mailto:${p.email}`} className="hover:text-zinc-200 transition-colors">{p.email}</a> : <span className="text-zinc-700">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-400">{p.phone ?? <span className="text-zinc-700">—</span>}</td>
                  <td className="px-4 py-2.5 text-zinc-400 max-w-[200px] truncate">{p.address ?? <span className="text-zinc-700">—</span>}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex gap-3 justify-end">
                      <button onClick={() => openEdit(p)} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">Edit</button>
                      <button onClick={() => handleDelete(p.id, p.company_name)} className="text-xs text-zinc-600 hover:text-red-400 transition-colors">Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <Modal title={editingId ? `Edit ${kindLabel}` : `New ${kindLabel}`} onClose={() => setShowModal(false)}>
          <form onSubmit={handleSubmit} className="space-y-4">
            <Field label="Company Name" required>
              <input className="inp" value={form.company_name} required
                onChange={(e) => setForm((f) => ({ ...f, company_name: e.target.value }))} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="First Name">
                <input className="inp" value={form.first_name}
                  onChange={(e) => setForm((f) => ({ ...f, first_name: e.target.value }))} />
              </Field>
              <Field label="Last Name">
                <input className="inp" value={form.last_name}
                  onChange={(e) => setForm((f) => ({ ...f, last_name: e.target.value }))} />
              </Field>
            </div>
            <Field label="Email">
              <input type="email" className="inp" value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
            </Field>
            <Field label="Phone">
              <input className="inp" value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
            </Field>
            <Field label="Address">
              <input className="inp" value={form.address}
                onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} />
            </Field>
            <Field label="Notes">
              <textarea className="inp resize-none" rows={2} value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
            </Field>
            <ModalActions submitting={submitting} onCancel={() => setShowModal(false)}
              label={editingId ? "Save Changes" : `Add ${kindLabel}`} />
          </form>
        </Modal>
      )}
    </>
  );
}
