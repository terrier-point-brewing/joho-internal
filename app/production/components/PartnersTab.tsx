"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ContractBrewingPartner, Supplier } from "../types";
import { Modal, Field, ModalActions } from "./shared";
import { useContractPartnersQuery, useSuppliersQuery, productionKeys } from "../hooks/queries";

type PartnerKind = "contract" | "supplier";

const PARTNER_EMPTY = {
  company_name: "",
  first_name: "",
  last_name: "",
  phone: "",
  address: "",
  email: "",
  notes: "",
  export_net_terms_days: "",
};

function partnerApiBase(kind: PartnerKind) {
  return kind === "contract" ? "/api/partners/contract-brewing" : "/api/partners/suppliers";
}

// ─── Square contact type (mirrors lib/square/customers.ts) ───────────────────
interface SquareContact {
  id: string;
  given_name?: string;
  family_name?: string;
  company_name?: string;
  email_address?: string;
  phone_number?: string;
}

function squareContactLabel(c: SquareContact): string {
  const parts: string[] = [];
  if (c.company_name) parts.push(c.company_name);
  const name = [c.given_name, c.family_name].filter(Boolean).join(" ");
  if (name && name !== c.company_name) parts.push(name);
  if (c.email_address) parts.push(c.email_address);
  return parts.join(" · ") || c.id;
}

// ─── Square Import Modal ──────────────────────────────────────────────────────
interface SquareImportModalProps {
  /** If provided, we're linking an existing partner; otherwise a fresh import creates a new one. */
  linkingPartner?: ContractBrewingPartner;
  onClose: () => void;
  onDone: () => void;
}

function SquareImportModal({ linkingPartner, onClose, onDone }: SquareImportModalProps) {
  const [query, setQuery] = useState("");
  const [contacts, setContacts] = useState<SquareContact[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<SquareContact | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchContacts = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/square/contacts?query=${encodeURIComponent(q)}`);
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Failed to fetch Square contacts");
      }
      setContacts(await res.json());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }, []);

  // Load on mount (show recent contacts). This is an imperative, debounced
  // search box, not cached list data — the mount fetch is intentional.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { fetchContacts(""); }, [fetchContacts]);

  function handleQueryChange(e: React.ChangeEvent<HTMLInputElement>) {
    const q = e.target.value;
    setQuery(q);
    setSelected(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchContacts(q), 350);
  }

  async function handleImport() {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload: Record<string, string> = { square_customer_id: selected.id };
      if (linkingPartner) payload.partner_id = linkingPartner.id;

      const res = await fetch("/api/partners/contract-brewing/square-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Import failed");
      }
      onDone();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error");
      setSubmitting(false);
    }
  }

  const title = linkingPartner
    ? `Link "${linkingPartner.company_name}" to Square`
    : "Import from Square";

  const actionLabel = linkingPartner ? "Link" : "Import as New Partner";

  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-4">
        {linkingPartner && (
          <p className="text-xs text-zinc-500">
            Select a Square contact to link. The partner&apos;s contact fields will be synced
            from Square. You can edit them manually afterwards.
          </p>
        )}

        <Field label="Search Square contacts">
          <input
            className="inp"
            placeholder="Name, company, or email…"
            value={query}
            onChange={handleQueryChange}
            autoFocus
          />
        </Field>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="border border-zinc-800 rounded-lg overflow-hidden max-h-72 overflow-y-auto">
          {loading ? (
            <p className="px-4 py-6 text-sm text-zinc-500 text-center">Searching…</p>
          ) : contacts.length === 0 ? (
            <p className="px-4 py-6 text-sm text-zinc-600 text-center">No contacts found</p>
          ) : (
            <ul>
              {contacts.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(c)}
                    className={`w-full text-left px-4 py-2.5 text-sm transition-colors border-b border-zinc-800/60 last:border-0 ${
                      selected?.id === c.id
                        ? "bg-amber-500/10 text-amber-300"
                        : "text-zinc-300 hover:bg-zinc-800/60"
                    }`}
                  >
                    {c.company_name && (
                      <div className="font-medium leading-snug">{c.company_name}</div>
                    )}
                    {(c.given_name || c.family_name) && (
                      <div className={`leading-snug ${c.company_name ? "text-xs text-zinc-400" : "font-medium"}`}>
                        {[c.given_name, c.family_name].filter(Boolean).join(" ")}
                      </div>
                    )}
                    {!c.company_name && !c.given_name && !c.family_name && (
                      <div className="font-medium leading-snug text-zinc-500">—</div>
                    )}
                    {c.email_address && (
                      <div className="text-xs text-zinc-500 leading-snug mt-0.5">{c.email_address}</div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {selected && (
          <p className="text-xs text-zinc-500">
            Selected: <span className="text-zinc-300">{squareContactLabel(selected)}</span>
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="btn-ghost text-sm"
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleImport}
            disabled={!selected || submitting}
            className="btn-amber text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? "Importing…" : actionLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function PartnersTab() {
  const qc = useQueryClient();
  const [kind, setKind] = useState<PartnerKind>("contract");
  const { data: contractPartners = [] } = useContractPartnersQuery();
  const { data: suppliers = [] } = useSuppliersQuery();
  const loadContracts = () => qc.invalidateQueries({ queryKey: productionKeys.contractPartners });
  const loadSuppliers = () => qc.invalidateQueries({ queryKey: productionKeys.suppliers });

  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(PARTNER_EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Square import modal state
  const [showSquareModal, setShowSquareModal] = useState(false);
  const [linkingPartner, setLinkingPartner] = useState<ContractBrewingPartner | undefined>(undefined);

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
      export_net_terms_days: "export_net_terms_days" in p && p.export_net_terms_days != null ? String(p.export_net_terms_days) : "",
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
        ...(kind === "contract" ? { export_net_terms_days: form.export_net_terms_days ? Number(form.export_net_terms_days) : null } : {}),
      };
      const res = editingId
        ? await fetch(`${base}/${editingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        : await fetch(base,                   { method: "POST",  headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setShowModal(false);
      if (kind === "contract") await loadContracts(); else await loadSuppliers();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    await fetch(`${partnerApiBase(kind)}/${id}`, { method: "DELETE" });
    if (kind === "contract") await loadContracts(); else await loadSuppliers();
  }

  async function handleUnlinkSquare(partner: ContractBrewingPartner) {
    if (!confirm(`Unlink "${partner.company_name}" from Square? Contact fields will not change.`)) return;
    await fetch(`/api/partners/contract-brewing/${partner.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...partner, square_customer_id: null }),
    });
    await loadContracts();
  }

  function openSquareImport() {
    setLinkingPartner(undefined);
    setShowSquareModal(true);
  }

  function openSquareLink(partner: ContractBrewingPartner) {
    setLinkingPartner(partner);
    setShowSquareModal(true);
  }

  async function handleSquareDone() {
    setShowSquareModal(false);
    await loadContracts();
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
        <div className="flex gap-2">
          {kind === "contract" && (
            <button onClick={openSquareImport} className="btn-amber">
              ↓ Import from Square
            </button>
          )}
          <button onClick={openNew} className="btn-amber">+ New {kindLabel}</button>
        </div>
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
                {kind === "contract" && (
                  <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Square</th>
                )}
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500"></th>
              </tr>
            </thead>
            <tbody>
              {records.map((p, i) => {
                const isContract = kind === "contract";
                const cp = p as ContractBrewingPartner;
                return (
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
                    {isContract && (
                      <td className="px-4 py-2.5">
                        {cp.square_customer_id ? (
                          <span
                            title={`Square ID: ${cp.square_customer_id}`}
                            className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-400 border border-emerald-800/50"
                          >
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
                            Linked
                          </span>
                        ) : (
                          <span className="text-zinc-700 text-xs">—</span>
                        )}
                      </td>
                    )}
                    <td className="px-4 py-2.5">
                      <div className="flex gap-3 justify-end items-center">
                        {isContract && (
                          cp.square_customer_id ? (
                            <button
                              onClick={() => handleUnlinkSquare(cp)}
                              className="text-xs text-zinc-600 hover:text-amber-400 transition-colors"
                              title="Unlink Square contact"
                            >
                              Unlink
                            </button>
                          ) : (
                            <button
                              onClick={() => openSquareLink(cp)}
                              className="text-xs text-zinc-500 hover:text-amber-400 transition-colors"
                              title="Link a Square contact"
                            >
                              Link Square
                            </button>
                          )
                        )}
                        {isContract && cp.square_customer_id ? (
                          <span className="text-xs text-zinc-700 cursor-default" title="Unlink from Square to edit manually">Edit</span>
                        ) : (
                          <button onClick={() => openEdit(p)} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">Edit</button>
                        )}
                        <button onClick={() => handleDelete(p.id, p.company_name)} className="text-xs text-zinc-600 hover:text-red-400 transition-colors">Delete</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Edit / New partner modal */}
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
            {kind === "contract" && (
              <Field label="Export Net Terms (days)" hint="Leave blank to use the global default">
                <input type="number" min={1} max={365} className="inp" value={form.export_net_terms_days}
                  onChange={(e) => setForm((f) => ({ ...f, export_net_terms_days: e.target.value }))} />
              </Field>
            )}
            <ModalActions submitting={submitting} onCancel={() => setShowModal(false)}
              label={editingId ? "Save Changes" : `Add ${kindLabel}`} />
          </form>
        </Modal>
      )}

      {/* Square import / link modal */}
      {showSquareModal && (
        <SquareImportModal
          linkingPartner={linkingPartner}
          onClose={() => setShowSquareModal(false)}
          onDone={handleSquareDone}
        />
      )}
    </>
  );
}
