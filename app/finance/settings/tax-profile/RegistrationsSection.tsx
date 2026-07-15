"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Card from "@/app/components/ui/Card";
import Banner from "@/app/components/ui/Banner";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import type { TaxAuthority } from "@/lib/tax/authorities";
import type { TaxRegistrationInput } from "@/lib/tax/registrations";
import type { RegistrationsResponse } from "../../tax/hooks/useTaxData";

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
type RequiredDrafts = Record<string, string>; // "authorityKey:registrationKey" -> number

function dedupeKey(authorityKey: string, registrationKey: string): string {
  return `${authorityKey}:${registrationKey}`;
}

/**
 * Groups the FREEFORM ("Other") rows by authority, excluding any row whose
 * (authority_key, key) is already covered by a resolved requirement — those
 * are edited in the "Required for active filings" block instead, never both.
 */
function groupOtherRegistrations(
  authorities: TaxAuthority[],
  data: RegistrationsResponse,
): Drafts {
  const requiredIds = new Set(data.required.map((r) => r.id).filter((id): id is string => Boolean(id)));
  const drafts: Drafts = {};
  for (const authority of authorities) {
    drafts[authority.key] = [];
  }
  for (const reg of data.registrations) {
    if (requiredIds.has(reg.id)) continue;
    if (!drafts[reg.authority_key]) drafts[reg.authority_key] = [];
    drafts[reg.authority_key].push({ id: reg.id, label: reg.label, number: reg.number ?? "" });
  }
  return drafts;
}

function initialRequiredDrafts(data: RegistrationsResponse): RequiredDrafts {
  const drafts: RequiredDrafts = {};
  for (const req of data.required) {
    drafts[dedupeKey(req.authorityKey, req.registrationKey)] = req.number ?? "";
  }
  return drafts;
}

/**
 * Per-authority registration/license numbers (`tax_registrations`). Two
 * blocks:
 *  - Required for active filings: one row per resolved requirement
 *    (`GET /api/tax/registrations`'s `required` field) — label locked, only
 *    the number is editable, matched by (authority_key, key), never "first
 *    row for this authority".
 *  - Other registrations: today's freeform per-authority editor, minus
 *    whatever's already covered above.
 * Both flatten into ONE `PUT /api/tax/registrations` call on Save — the
 * full-reconcile-on-save contract (lib/tax/registrations.ts's
 * `saveRegistrations`) is unchanged.
 */
export default function RegistrationsSection() {
  const qc = useQueryClient();
  const authoritiesQuery = useQuery({
    queryKey: queryKeys.tax.authorities(),
    queryFn: () => fetchJson<TaxAuthority[]>("/api/tax/authorities"),
  });
  const registrationsQuery = useQuery({
    queryKey: queryKeys.tax.registrations(),
    queryFn: () => fetchJson<RegistrationsResponse>("/api/tax/registrations"),
  });

  const [requiredDrafts, setRequiredDrafts] = useState<RequiredDrafts>({});
  const [otherDrafts, setOtherDrafts] = useState<Drafts>({});
  const initializedRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (authoritiesQuery.data && registrationsQuery.data && !initializedRef.current) {
      setRequiredDrafts(initialRequiredDrafts(registrationsQuery.data));
      setOtherDrafts(groupOtherRegistrations(authoritiesQuery.data, registrationsQuery.data));
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
  const required = registrationsQuery.data?.required ?? [];

  function updateRequired(authorityKey: string, registrationKey: string, number: string) {
    setRequiredDrafts((cur) => ({ ...cur, [dedupeKey(authorityKey, registrationKey)]: number }));
    setSaved(false);
  }

  function updateOtherRow(authorityKey: string, index: number, patch: Partial<Row>) {
    setOtherDrafts((cur) => {
      const rows = cur[authorityKey] ?? [];
      const nextRows = rows.map((row, i) => (i === index ? { ...row, ...patch } : row));
      return { ...cur, [authorityKey]: nextRows };
    });
    setSaved(false);
  }

  function addOtherRow(authorityKey: string) {
    setOtherDrafts((cur) => ({
      ...cur,
      [authorityKey]: [...(cur[authorityKey] ?? []), { label: "", number: "" }],
    }));
    setSaved(false);
  }

  function removeOtherRow(authorityKey: string, index: number) {
    setOtherDrafts((cur) => ({
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

      for (const req of required) {
        const number = requiredDrafts[dedupeKey(req.authorityKey, req.registrationKey)] ?? "";
        rows.push({
          id: req.id,
          authority_key: req.authorityKey,
          key: req.registrationKey,
          label: req.label,
          number: number.trim() || null,
          display_order: 0,
        });
      }

      for (const authorityKey of Object.keys(otherDrafts)) {
        const authorityRows = otherDrafts[authorityKey] ?? [];
        let order = 0;
        for (const row of authorityRows) {
          // A registration needs a label; skip blank rows (incl. a number typed
          // with no label — meaningless without one).
          if (!row.label.trim()) continue;
          rows.push({
            id: row.id,
            authority_key: authorityKey,
            label: row.label.trim(),
            number: row.number.trim() || null,
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
        qc.invalidateQueries({ queryKey: queryKeys.tax.parties() }),
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

        {required.length > 0 && (
          <div className="space-y-2 pb-4 border-b border-line">
            <h4 className="text-sm font-medium text-primary">Required for active filings</h4>
            <div className="space-y-2">
              {required.map((req) => (
                <div key={dedupeKey(req.authorityKey, req.registrationKey)} className="flex items-center gap-2">
                  <span className="flex-1 text-sm text-body">{req.label}</span>
                  <input
                    type="text"
                    className="inp-sm flex-1"
                    placeholder="Number"
                    value={requiredDrafts[dedupeKey(req.authorityKey, req.registrationKey)] ?? ""}
                    onChange={(e) => updateRequired(req.authorityKey, req.registrationKey, e.target.value)}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-2">
          <h4 className="text-sm font-medium text-primary">Other registrations</h4>
          {authorities.length === 0 && <p className="text-sm text-faint">No tax authorities configured.</p>}

          {authorities.map((authority) => (
            <div key={authority.key} className="space-y-2 pb-4 border-b border-line last:border-0 last:pb-0">
              <h5 className="text-xs font-medium text-faint uppercase tracking-wide">{authority.label}</h5>
              <div className="space-y-2">
                {(otherDrafts[authority.key] ?? []).map((row, index) => (
                  <div key={row.id ?? `new-${index}`} className="flex items-center gap-2">
                    <input
                      type="text"
                      className="inp-sm flex-1"
                      placeholder="Label (e.g. Permit #)"
                      value={row.label}
                      onChange={(e) => updateOtherRow(authority.key, index, { label: e.target.value })}
                    />
                    <input
                      type="text"
                      className="inp-sm flex-1"
                      placeholder="Number"
                      value={row.number}
                      onChange={(e) => updateOtherRow(authority.key, index, { number: e.target.value })}
                    />
                    <button
                      type="button"
                      className="btn-secondary btn-xxs"
                      onClick={() => removeOtherRow(authority.key, index)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                {(otherDrafts[authority.key] ?? []).length === 0 && (
                  <p className="text-xs text-faint">No other registrations for this authority.</p>
                )}
              </div>
              <button type="button" className="btn-secondary btn-xxs" onClick={() => addOtherRow(authority.key)}>
                + Add registration
              </button>
            </div>
          ))}
        </div>

        {(authorities.length > 0 || required.length > 0) && (
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
