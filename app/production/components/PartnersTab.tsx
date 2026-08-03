"use client";

import { useState, useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ContractBrewingPartner, Supplier } from "../types";
import { Modal, Field, ModalActions } from "./shared";
import SearchInput from "@/app/components/ui/SearchInput";
import { useContractPartnersQuery, useSuppliersQuery, productionKeys } from "../hooks/queries";
import type { PartnerKind } from "../partners/page";

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
          <p className="text-xs text-muted">
            Select a Square contact to link. The partner&apos;s contact fields will be synced
            from Square. You can edit them manually afterwards.
          </p>
        )}

        <Field label="Search Square contacts">
          <SearchInput
            value={query}
            onChange={(v) => { setQuery(v); setSelected(null); fetchContacts(v); }}
            placeholder="Search by name, company, or email…"
            debounceMs={350}
            autoFocus
            className="max-w-none"
          />
        </Field>

        {error && <p className="text-xs text-danger">{error}</p>}

        <div className="border border-line rounded-lg overflow-hidden max-h-72 overflow-y-auto">
          {loading ? (
            <p className="px-4 py-6 text-sm text-muted text-center">Searching…</p>
          ) : contacts.length === 0 ? (
            <p className="px-4 py-6 text-sm text-faint text-center">No contacts found</p>
          ) : (
            <ul>
              {contacts.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(c)}
                    className={`w-full text-left px-4 py-2.5 text-sm transition-colors border-b border-line/60 last:border-0 ${
                      selected?.id === c.id
                        ? "bg-accent-emphasis/10 text-accent-soft"
                        : "text-body hover:bg-surface-mid/60"
                    }`}
                  >
                    {c.company_name && (
                      <div className="font-medium leading-snug">{c.company_name}</div>
                    )}
                    {(c.given_name || c.family_name) && (
                      <div className={`leading-snug ${c.company_name ? "text-xs text-secondary" : "font-medium"}`}>
                        {[c.given_name, c.family_name].filter(Boolean).join(" ")}
                      </div>
                    )}
                    {!c.company_name && !c.given_name && !c.family_name && (
                      <div className="font-medium leading-snug text-muted">—</div>
                    )}
                    {c.email_address && (
                      <div className="text-xs text-muted leading-snug mt-0.5">{c.email_address}</div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {selected && (
          <p className="text-xs text-muted">
            Selected: <span className="text-body">{squareContactLabel(selected)}</span>
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary"
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleImport}
            disabled={!selected || submitting}
            className="btn-primary"
          >
            {submitting ? "Importing…" : actionLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function PartnersTab({ kind, setKind }: { kind: PartnerKind; setKind: (k: PartnerKind) => void }) {
  const qc = useQueryClient();
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
      {/* Action buttons */}
      <div className="flex justify-end gap-2 mb-4">
        {kind === "contract" && (
          <button onClick={openSquareImport} className="btn-primary">
            ↓ Import from Square
          </button>
        )}
        <button onClick={openNew} className="btn-primary">+ New {kindLabel}</button>
      </div>

      {/* Records table */}
      {records.length === 0 ? (
        <p className="text-faint text-sm">No {kindLabel.toLowerCase()}s yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface/50 text-left">
                <th className="px-4 py-2.5 text-xs font-medium text-muted">Company</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted">Contact</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted">Email</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted">Phone</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted">Address</th>
                {kind === "contract" && (
                  <th className="px-4 py-2.5 text-xs font-medium text-muted">Square</th>
                )}
                <th className="px-4 py-2.5 text-xs font-medium text-muted"></th>
              </tr>
            </thead>
            <tbody>
              {records.map((p, i) => {
                const isContract = kind === "contract";
                const cp = p as ContractBrewingPartner;
                return (
                  <tr key={p.id} className={`border-b border-line/60 ${i % 2 !== 0 ? "bg-surface/30" : ""}`}>
                    <td className="px-4 py-2.5 text-primary font-medium">{p.company_name}</td>
                    <td className="px-4 py-2.5 text-secondary">
                      {[p.first_name, p.last_name].filter(Boolean).join(" ") || <span className="text-disabled">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-secondary">
                      {p.email ? <a href={`mailto:${p.email}`} className="hover:text-strong transition-colors">{p.email}</a> : <span className="text-disabled">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-secondary">{p.phone ?? <span className="text-disabled">—</span>}</td>
                    <td className="px-4 py-2.5 text-secondary max-w-[200px] truncate">{p.address ?? <span className="text-disabled">—</span>}</td>
                    {isContract && (
                      <td className="px-4 py-2.5">
                        {cp.square_customer_id ? (
                          <span
                            title={`Square ID: ${cp.square_customer_id}`}
                            className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-success-surface/40 text-success border border-success-border/50"
                          >
                            <span className="w-1.5 h-1.5 rounded-full bg-success-emphasis inline-block" />
                            Linked
                          </span>
                        ) : (
                          <span className="text-disabled text-xs">—</span>
                        )}
                      </td>
                    )}
                    <td className="px-4 py-2.5">
                      <div className="flex gap-3 justify-end items-center">
                        {isContract && (
                          cp.square_customer_id ? (
                            <button
                              onClick={() => handleUnlinkSquare(cp)}
                              className="text-xs text-faint hover:text-accent transition-colors"
                              title="Unlink Square contact"
                            >
                              Unlink
                            </button>
                          ) : (
                            <button
                              onClick={() => openSquareLink(cp)}
                              className="text-xs text-muted hover:text-accent transition-colors"
                              title="Link a Square contact"
                            >
                              Link Square
                            </button>
                          )
                        )}
                        {isContract && cp.square_customer_id ? (
                          <span className="text-xs text-disabled cursor-default" title="Unlink from Square to edit manually">Edit</span>
                        ) : (
                          <button onClick={() => openEdit(p)} className="text-xs text-muted hover:text-body transition-colors">Edit</button>
                        )}
                        <button onClick={() => handleDelete(p.id, p.company_name)} className="text-xs text-faint hover:text-danger transition-colors">Delete</button>
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
