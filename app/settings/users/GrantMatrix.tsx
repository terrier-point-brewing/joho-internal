"use client";

import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";
import { Modal, ModalActions } from "@/app/components/ui/Modal";
import Banner from "@/app/components/ui/Banner";
import { queryKeys } from "@/lib/query-keys";
import { SCOPES, ROOT, type ScopeKey, type Section } from "@/lib/auth/scopes";
import type { Level } from "@/lib/auth/levels";

interface GrantsResponse {
  grants: Record<string, Level>;
}

// "inherit" (no key stored — the effective level cascades from an ancestor
// section/ROOT grant, or from nothing at all) is a UI-only pseudo-state.
// "none" is a real, storable Level — an explicit revoke that beats any
// inherited grant. These must stay visually and semantically distinct: an
// admin has to be able to tell "inherits read" from "revoked".
type DisplayLevel = "inherit" | Level;

const LEVEL_LABELS: Record<Level, string> = {
  none: "None",
  read: "Read",
  operate: "Operate",
  manage: "Manage",
  admin: "Admin",
};

/**
 * Longest-prefix-wins over strict ancestors of `key` only (ROOT, or a
 * dot-prefix of `key` other than `key` itself) — i.e. what `key`'s effective
 * level would be if its own grant were absent. Used to label the "Inherit"
 * option with the level it actually resolves to.
 */
function ancestorLevel(grants: Record<string, DisplayLevel>, key: string): Level | null {
  let best: Level | null = null;
  let bestLen = -1;
  for (const [k, v] of Object.entries(grants)) {
    if (v === "inherit") continue;
    const isAncestor = k === ROOT || (k !== key && key.startsWith(k + "."));
    if (isAncestor && k.length > bestLen) {
      best = v;
      bestLen = k.length;
    }
  }
  return best;
}

function levelOptions(inherited: Level | null): { value: DisplayLevel; label: string }[] {
  return [
    { value: "inherit", label: inherited ? `Inherit (${LEVEL_LABELS[inherited]})` : "Inherit (no access)" },
    { value: "none", label: "None (revoked)" },
    { value: "read", label: "Read" },
    { value: "operate", label: "Operate" },
    { value: "manage", label: "Manage" },
    { value: "admin", label: "Admin" },
  ];
}

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

// A handful of scopes (payroll, tax) are both a Section and a leaf ScopeKey
// of the same name — the section dropdown above already covers that grant,
// so the identically-keyed leaf row is skipped to avoid two controls writing
// the same `grants` key.
const LEAVES_BY_SECTION: Record<Section, { key: ScopeKey; label: string }[]> = SECTION_ORDER.reduce(
  (acc, section) => {
    acc[section] = (Object.entries(SCOPES) as [ScopeKey, { label: string; section: Section }][])
      .filter(([key, v]) => v.section === section && key !== section)
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
    setGrants((prev) => {
      const next = { ...prev };
      // "inherit" is expressed by omitting the key, not by storing a value —
      // that is what makes the effective level cascade from an ancestor
      // section/ROOT grant again.
      if (value === "inherit") delete next[key];
      else next[key] = value;
      return next;
    });
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
    // Every key remaining in `grants` is a real, explicit Level (including
    // "none" — a stored revoke). "inherit" is never stored; it is expressed
    // by the key's absence, which is exactly what omitting it here achieves.
    const payload: Record<string, Level> = {};
    for (const [key, value] of Object.entries(grants)) {
      if (value !== "inherit") payload[key] = value;
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

  // Absent data (query error, or a resolved-but-empty response) must never
  // fall through to a saveable form — that form would seed as all-"inherit"
  // and PUT `{}`, wiping every existing grant for this user.
  const loadFailed = !isLoading && (!!error || !data);

  return (
    <Modal title={`Grants — ${email}`} onClose={onClose} wide>
      {saveError && <Banner tone="danger" className="mb-4">{saveError}</Banner>}

      {isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : loadFailed ? (
        <Banner tone="danger">
          {error instanceof Error ? error.message : "Failed to load grants — try reopening this dialog."}
        </Banner>
      ) : (
        <form onSubmit={handleSave}>
        <div className="divide-y divide-line">
          {SECTION_ORDER.map((section) => {
            const leaves = LEAVES_BY_SECTION[section];
            const isExpanded = expanded.has(section);
            const sectionInherited = ancestorLevel(grants, section);
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
                    value={grants[section] ?? "inherit"}
                    onChange={(e) => setLevel(section, e.target.value as DisplayLevel)}
                  >
                    {levelOptions(sectionInherited).map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>

                {isExpanded && (
                  <div className="mt-2 ml-4 space-y-1.5">
                    {leaves.map((leaf) => {
                      const leafInherited = ancestorLevel(grants, leaf.key);
                      return (
                      <div key={leaf.key} className="flex items-center justify-between gap-3">
                        <span className="text-xs text-secondary">{leaf.label}</span>
                        <select
                          className="inp-sm w-32"
                          value={grants[leaf.key] ?? "inherit"}
                          onChange={(e) => setLevel(leaf.key, e.target.value as DisplayLevel)}
                        >
                          {levelOptions(leafInherited).map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      </div>
                      );
                    })}
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
