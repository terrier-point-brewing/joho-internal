"use client";

import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";
import { Modal, ModalActions } from "@/app/components/ui/Modal";
import Banner from "@/app/components/ui/Banner";
import { queryKeys } from "@/lib/query-keys";
import { SCOPES, type ScopeKey, type Section } from "@/lib/auth/scopes";
import type { Level } from "@/lib/auth/levels";

interface GrantsResponse {
  grants: Record<string, Level>;
}

type DisplayLevel = "none" | Level;

const LEVEL_OPTIONS: { value: DisplayLevel; label: string }[] = [
  { value: "none", label: "None" },
  { value: "read", label: "Read" },
  { value: "operate", label: "Operate" },
  { value: "manage", label: "Manage" },
  { value: "admin", label: "Admin" },
];

// Section display order + label — SCOPES only carries per-leaf labels, so the
// section header text lives here, one shared place for this one component.
const SECTION_ORDER: Section[] = ["taproom", "production", "finance", "payroll", "tax", "brand", "settings"];
const SECTION_LABELS: Record<Section, string> = {
  taproom: "Taproom",
  production: "Production",
  finance: "Finance",
  payroll: "Payroll",
  tax: "Tax",
  brand: "Brand",
  settings: "Settings",
};

const LEAVES_BY_SECTION: Record<Section, { key: ScopeKey; label: string }[]> = SECTION_ORDER.reduce(
  (acc, section) => {
    acc[section] = (Object.entries(SCOPES) as [ScopeKey, { label: string; section: Section }][])
      .filter(([, v]) => v.section === section)
      .map(([key, v]) => ({ key, label: v.label }));
    return acc;
  },
  {} as Record<Section, { key: ScopeKey; label: string }[]>,
);

export default function GrantMatrix({ userId, email, onClose }: { userId: string; email: string; onClose: () => void }) {
  const qc = useQueryClient();
  const queryKey = ["admin", "users", userId, "grants"] as const;

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => fetchJson<GrantsResponse>(`/api/admin/users/${userId}/grants`),
  });

  const [grants, setGrants] = useState<Record<string, DisplayLevel>>({});
  // Seeds local editable state from the fetched grants exactly once per
  // load — a render-time derivation (React's documented pattern for
  // "adjusting state when a prop/query result changes"), not an effect.
  const [seededFrom, setSeededFrom] = useState<GrantsResponse | undefined>(undefined);
  if (data && data !== seededFrom) {
    setSeededFrom(data);
    setGrants(data.grants);
  }
  const [expanded, setExpanded] = useState<Set<Section>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function setLevel(key: string, value: DisplayLevel) {
    setGrants((prev) => ({ ...prev, [key]: value }));
  }

  function toggleExpanded(section: Section) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    const payload: Record<string, Level> = {};
    for (const [key, value] of Object.entries(grants)) {
      if (value !== "none") payload[key] = value;
    }
    const res = await fetch(`/api/admin/users/${userId}/grants`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grants: payload }),
    });
    setSaving(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setSaveError(body.error ?? "Failed to save grants");
      return;
    }
    // useUserRole has staleTime: Infinity — without this the edited user's
    // affordances/API access won't reflect the change until they reload.
    await qc.invalidateQueries({ queryKey: queryKeys.auth.all() });
    await qc.invalidateQueries({ queryKey });
    onClose();
  }

  return (
    <Modal title={`Grants — ${email}`} onClose={onClose} wide>
      {saveError && <Banner tone="danger" className="mb-4">{saveError}</Banner>}
      {error && <Banner tone="danger" className="mb-4">{(error as Error).message}</Banner>}

      {isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <form onSubmit={handleSave}>
        <div className="divide-y divide-line">
          {SECTION_ORDER.map((section) => {
            const leaves = LEAVES_BY_SECTION[section];
            const isExpanded = expanded.has(section);
            return (
              <div key={section} className="py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => toggleExpanded(section)}
                    className="flex items-center gap-1.5 text-sm text-body hover:text-strong transition-colors"
                  >
                    <span className="text-faint text-xs w-3 inline-block">{isExpanded ? "▼" : "▶"}</span>
                    {SECTION_LABELS[section]}
                  </button>
                  <select
                    className="inp-sm w-32"
                    value={grants[section] ?? "none"}
                    onChange={(e) => setLevel(section, e.target.value as DisplayLevel)}
                  >
                    {LEVEL_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>

                {isExpanded && (
                  <div className="mt-2 ml-4 space-y-1.5">
                    {leaves.map((leaf) => (
                      <div key={leaf.key} className="flex items-center justify-between gap-3">
                        <span className="text-xs text-secondary">{leaf.label}</span>
                        <select
                          className="inp-sm w-32"
                          value={grants[leaf.key] ?? "none"}
                          onChange={(e) => setLevel(leaf.key, e.target.value as DisplayLevel)}
                        >
                          {LEVEL_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <ModalActions submitting={saving} onCancel={onClose} label="Save grants" />
        </form>
      )}
    </Modal>
  );
}
