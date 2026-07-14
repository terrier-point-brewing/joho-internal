"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Card from "@/app/components/ui/Card";
import Banner from "@/app/components/ui/Banner";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import type { TaxAuthority } from "@/lib/tax/authorities";
import type { TaxRegistration } from "@/lib/tax/registrations";

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

/**
 * Lists per-authority account/license registrations
 * (`GET /api/tax/registrations`, see lib/tax/registrations.ts) grouped by
 * their `tax_authorities` label. Commits on input blur — the whole row set
 * (with the edited row's `number` applied) is sent to
 * `PUT /api/tax/registrations`, which fully replaces the table.
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

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const registrations = registrationsQuery.data ?? [];
  const authorityLabel = new Map((authoritiesQuery.data ?? []).map((a) => [a.key, a.label]));

  async function commit(registration: TaxRegistration, value: string) {
    if (value === (registration.number ?? "")) return;
    setSavingId(registration.id);
    setSavedId(null);
    setError(null);
    try {
      const rows = registrations.map((r) => (r.id === registration.id ? { ...r, number: value || null } : r));
      await putJson("/api/tax/registrations", rows);
      await qc.invalidateQueries({ queryKey: queryKeys.tax.registrations() });
      setSavedId(registration.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save registration number.");
    } finally {
      setSavingId(null);
    }
  }

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

  return (
    <Card padding="">
      <div className="p-4 space-y-3">
        {error && <Banner tone="danger">{error}</Banner>}
        {registrations.length === 0 && <p className="text-sm text-faint">No registrations configured.</p>}
      </div>
      {registrations.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="px-4 py-2 font-medium">Authority</th>
              <th className="px-4 py-2 font-medium">Registration</th>
              <th className="px-4 py-2 font-medium">Number</th>
            </tr>
          </thead>
          <tbody>
            {registrations.map((registration) => (
              <tr key={registration.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2 text-body">
                  {authorityLabel.get(registration.authority_key) ?? registration.authority_key}
                </td>
                <td className="px-4 py-2 text-body">{registration.label}</td>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <input
                      key={`${registration.id}-${registration.number ?? ""}`}
                      type="text"
                      className="inp-sm"
                      defaultValue={registration.number ?? ""}
                      onChange={(e) => setDrafts((cur) => ({ ...cur, [registration.id]: e.target.value }))}
                      onBlur={(e) => commit(registration, drafts[registration.id] ?? e.target.value)}
                    />
                    {savingId === registration.id && <span className="text-xs text-faint">Saving…</span>}
                    {savedId === registration.id && savingId !== registration.id && (
                      <span className="text-xs text-success">Saved</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
