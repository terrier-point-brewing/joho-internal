"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Card from "@/app/components/ui/Card";
import Banner from "@/app/components/ui/Banner";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import type { TaxAuthority } from "@/lib/tax/authorities";
import type { TaxRegistration, TaxRegistrationInput } from "@/lib/tax/registrations";

async function putJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(err?.error ?? `Request failed (${res.status})`);
  }
  return res.json();
}

interface Row {
  id?: string;
  label: string;
  number: string;
}

type Drafts = Record<string, Row[]>;

function groupByAuthority(authorities: TaxAuthority[], registrations: TaxRegistration[]): Drafts {
  const drafts: Drafts = {};
  for (const authority of authorities) {
    drafts[authority.key] = [];
  }
  for (const reg of registrations) {
    if (!drafts[reg.authority_key]) drafts[reg.authority_key] = [];
    drafts[reg.authority_key].push({ id: reg.id, label: reg.label, number: reg.number ?? "" });
  }
  return drafts;
}

/**
 * Per-authority registration/license numbers (`tax_registrations`, one
 * authority → many free-text-labeled registrations — see
 * lib/tax/registrations.ts). Local draft state grouped by authority key;
 * explicit Save flattens every group's rows into
 * `PUT /api/tax/registrations`, which fully reconciles the table (rows
 * without an id are inserted, rows omitted from the payload are deleted).
 */
export default function RegistrationsSection() {
  const qc = useQueryClient();
  const authoritiesQuery = useQuery({
    queryKey: queryKeys.tax.authorities(),
    queryFn: () => fetchJson<TaxAuthority[]>("/api/tax/authorities"),
  });
  const registrationsQuery = useQuery({
    queryKey: queryKeys.tax.registrations(),
    queryFn: () => fetchJson<TaxRegistration[]>("/api/tax/registrations"),
  });

  const [drafts, setDrafts] = useState<Drafts>({});
  const initializedRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (authoritiesQuery.data && registrationsQuery.data && !initializedRef.current) {
      setDrafts(groupByAuthority(authoritiesQuery.data, registrationsQuery.data));
      initializedRef.current = true;
    }
  }, [authoritiesQuery.data, registrationsQuery.data]);

  const isLoading = authoritiesQuery.isLoading || registrationsQuery.isLoading;
  const isError = authoritiesQuery.isError || registrationsQuery.isError;

  if (isLoading) return <p className="text-sm text-faint">Loading…</p>;
  if (isError) {
    return (
      <Banner tone="danger">
        {authoritiesQuery.error instanceof Error
          ? authoritiesQuery.error.message
          : registrationsQuery.error instanceof Error
            ? registrationsQuery.error.message
            : "Failed to load tax registrations."}
      </Banner>
    );
  }

  const authorities = authoritiesQuery.data ?? [];

  function updateRow(authorityKey: string, index: number, patch: Partial<Row>) {
    setDrafts((cur) => {
      const rows = cur[authorityKey] ?? [];
      const nextRows = rows.map((row, i) => (i === index ? { ...row, ...patch } : row));
      return { ...cur, [authorityKey]: nextRows };
    });
    setSaved(false);
  }

  function addRow(authorityKey: string) {
    setDrafts((cur) => ({
      ...cur,
      [authorityKey]: [...(cur[authorityKey] ?? []), { label: "", number: "" }],
    }));
    setSaved(false);
  }

  function removeRow(authorityKey: string, index: number) {
    setDrafts((cur) => ({
      ...cur,
      [authorityKey]: (cur[authorityKey] ?? []).filter((_, i) => i !== index),
    }));
    setSaved(false);
  }

  async function handleSave() {
    setSubmitting(true);
    setError(null);
    setSaved(false);
    try {
      const rows: TaxRegistrationInput[] = [];
      for (const authorityKey of Object.keys(drafts)) {
        const authorityRows = drafts[authorityKey] ?? [];
        let order = 0;
        for (const row of authorityRows) {
          if (!row.label.trim() && !row.number.trim()) continue;
          rows.push({
            id: row.id,
            authority_key: authorityKey,
            label: row.label,
            number: row.number || null,
            display_order: order,
          });
          order += 1;
        }
      }
      await putJson("/api/tax/registrations", { rows });
      initializedRef.current = false;
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.tax.registrations() }),
        qc.invalidateQueries({ queryKey: queryKeys.tax.authorities() }),
      ]);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save registrations.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <div className="space-y-4">
        {error && <Banner tone="danger">{error}</Banner>}
        {saved && <Banner tone="success">Registrations saved.</Banner>}

        {authorities.length === 0 && <p className="text-sm text-faint">No tax authorities configured.</p>}

        {authorities.map((authority) => (
          <div key={authority.key} className="space-y-2 pb-4 border-b border-line last:border-0 last:pb-0">
            <h4 className="text-sm font-medium text-primary">{authority.label}</h4>
            <div className="space-y-2">
              {(drafts[authority.key] ?? []).map((row, index) => (
                <div key={row.id ?? `new-${index}`} className="flex items-center gap-2">
                  <input
                    type="text"
                    className="inp-sm flex-1"
                    placeholder="Label (e.g. FEIN, Permit #)"
                    value={row.label}
                    onChange={(e) => updateRow(authority.key, index, { label: e.target.value })}
                  />
                  <input
                    type="text"
                    className="inp-sm flex-1"
                    placeholder="Number"
                    value={row.number}
                    onChange={(e) => updateRow(authority.key, index, { number: e.target.value })}
                  />
                  <button
                    type="button"
                    className="btn-secondary btn-xxs"
                    onClick={() => removeRow(authority.key, index)}
                  >
                    Remove
                  </button>
                </div>
              ))}
              {(drafts[authority.key] ?? []).length === 0 && (
                <p className="text-xs text-faint">No registrations for this authority.</p>
              )}
            </div>
            <button type="button" className="btn-secondary btn-xxs" onClick={() => addRow(authority.key)}>
              + Add registration
            </button>
          </div>
        ))}

        {authorities.length > 0 && (
          <div className="flex justify-end pt-2 border-t border-line">
            <button type="button" className="btn-primary" onClick={handleSave} disabled={submitting}>
              {submitting ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}
