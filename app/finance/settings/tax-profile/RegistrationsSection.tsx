"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Card from "@/app/components/ui/Card";
import Banner from "@/app/components/ui/Banner";
import Badge from "@/app/components/ui/Badge";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import type { TaxAuthority } from "@/lib/tax/authorities";

async function patchJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PATCH",
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
 * Lists tax authorities (`GET /api/tax/authorities`) and lets an admin edit
 * each one's registration/license number inline. Commits on input blur via
 * `PATCH /api/tax/authorities` (per-authority `{ key, registration_number }`).
 */
export default function RegistrationsSection() {
  const qc = useQueryClient();
  const authoritiesQuery = useQuery({
    queryKey: queryKeys.tax.authorities(),
    queryFn: () => fetchJson<TaxAuthority[]>("/api/tax/authorities"),
  });

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function commit(authority: TaxAuthority, value: string) {
    const original = authority.registration_number ?? "";
    if (value === original) return;
    setSavingKey(authority.key);
    setSavedKey(null);
    setError(null);
    try {
      await patchJson("/api/tax/authorities", { key: authority.key, registration_number: value || null });
      await qc.invalidateQueries({ queryKey: queryKeys.tax.authorities() });
      setSavedKey(authority.key);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save registration number.");
    } finally {
      setSavingKey(null);
    }
  }

  if (authoritiesQuery.isLoading) return <p className="text-sm text-faint">Loading…</p>;
  if (authoritiesQuery.isError) {
    return (
      <Banner tone="danger">
        {authoritiesQuery.error instanceof Error ? authoritiesQuery.error.message : "Failed to load tax authorities."}
      </Banner>
    );
  }

  const authorities = authoritiesQuery.data ?? [];

  return (
    <Card padding="">
      <div className="p-4 space-y-3">
        {error && <Banner tone="danger">{error}</Banner>}
        {authorities.length === 0 && <p className="text-sm text-faint">No tax authorities configured.</p>}
      </div>
      {authorities.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="px-4 py-2 font-medium">Authority</th>
              <th className="px-4 py-2 font-medium">Type</th>
              <th className="px-4 py-2 font-medium">Registration / License #</th>
            </tr>
          </thead>
          <tbody>
            {authorities.map((authority) => (
              <tr key={authority.key} className="border-b border-line last:border-0">
                <td className="px-4 py-2 text-body">{authority.label}</td>
                <td className="px-4 py-2">
                  <Badge tone="neutral">{authority.kind}</Badge>
                </td>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <input
                      key={`${authority.key}-${authority.registration_number ?? ""}`}
                      type="text"
                      className="inp-sm"
                      defaultValue={authority.registration_number ?? ""}
                      onChange={(e) => setDrafts((cur) => ({ ...cur, [authority.key]: e.target.value }))}
                      onBlur={(e) => commit(authority, drafts[authority.key] ?? e.target.value)}
                    />
                    {savingKey === authority.key && <span className="text-xs text-faint">Saving…</span>}
                    {savedKey === authority.key && savingKey !== authority.key && (
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
