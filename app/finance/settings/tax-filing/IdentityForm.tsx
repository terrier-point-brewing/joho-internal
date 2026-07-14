"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Card from "@/app/components/ui/Card";
import Banner from "@/app/components/ui/Banner";
import { Field } from "@/app/components/ui/Modal";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import type { FieldSpec } from "@/lib/tax/types";
import type { SquareTaxOption } from "@/app/api/tax/square-taxes/route";
import { buildPutPayload, initialFormValues, isSensitivePresent } from "@/lib/tax/identityForm";

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
 * Generic form for a party's `settingsSchema` (contact info, FEIN/account
 * IDs, SSN). `GET /api/tax/profiles/[party]` masks `sensitive` fields to
 * `"present"`/`"absent"` — this form never seeds a real value into a
 * sensitive input (see `lib/tax/identityForm.initialFormValues`); those
 * inputs start blank and a blank submit means "leave unchanged" (the PUT
 * route merges, per lib/tax/profiles.ts). The `general_sales_tax_id` select
 * (type "select" with no static `options`) is populated from Square's live
 * catalog taxes via `/api/tax/square-taxes`.
 */
export default function IdentityForm({
  schema,
  endpoint,
  queryKey,
  savedLabel,
}: {
  schema: FieldSpec[];
  endpoint: string;
  queryKey: readonly unknown[];
  savedLabel?: string;
}) {
  const qc = useQueryClient();

  const profileQuery = useQuery({
    queryKey: queryKey as unknown[],
    queryFn: () => fetchJson<Record<string, string>>(endpoint),
  });

  const needsSquareTaxes = schema.some((f) => f.type === "select" && (!f.options || f.options.length === 0));
  const squareTaxesQuery = useQuery({
    queryKey: queryKeys.tax.squareTaxes(),
    queryFn: () => fetchJson<SquareTaxOption[]>("/api/tax/square-taxes"),
    enabled: needsSquareTaxes,
  });

  const [values, setValues] = useState<Record<string, string>>({});
  // Seeds `values` once per fresh masked GET (initial load, and again after a
  // successful save re-fetches). Cleared to false right before the
  // post-save refetch so the effect re-seeds from the new payload instead of
  // leaving stale form state (which would otherwise re-blank a
  // just-typed-but-unsaved sensitive value on an unrelated re-render).
  const initializedRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (profileQuery.data && !initializedRef.current) {
      setValues(initialFormValues(schema, profileQuery.data));
      initializedRef.current = true;
    }
  }, [profileQuery.data, schema]);

  function setField(key: string, value: string) {
    setValues((cur) => ({ ...cur, [key]: value }));
    setSaved(false);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setSaved(false);
    try {
      await putJson(endpoint, buildPutPayload(schema, values));
      initializedRef.current = false;
      await qc.invalidateQueries({ queryKey });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save filing identity.");
    } finally {
      setSubmitting(false);
    }
  }

  if (profileQuery.isLoading) return <p className="text-sm text-faint">Loading filing identity…</p>;
  if (profileQuery.isError) {
    return (
      <Banner tone="danger">
        {profileQuery.error instanceof Error ? profileQuery.error.message : "Failed to load filing identity."}
      </Banner>
    );
  }

  return (
    <Card>
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <Banner tone="danger">{error}</Banner>}
        {saved && <Banner tone="success">{savedLabel ?? "Saved."}</Banner>}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {schema.map((field) => (
            <Field key={field.key} label={field.label} required={field.required} hint={field.help}>
              <IdentityFieldInput
                field={field}
                value={values[field.key] ?? ""}
                onChange={(v) => setField(field.key, v)}
                masked={profileQuery.data}
                squareTaxes={squareTaxesQuery.data}
              />
            </Field>
          ))}
          {schema.length === 0 && <p className="text-sm text-faint">This party has no identity fields to configure.</p>}
        </div>

        {schema.length > 0 && (
          <div className="flex justify-end pt-2 border-t border-line">
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </form>
    </Card>
  );
}

function IdentityFieldInput({
  field,
  value,
  onChange,
  masked,
  squareTaxes,
}: {
  field: FieldSpec;
  value: string;
  onChange: (v: string) => void;
  masked?: Record<string, string>;
  squareTaxes?: SquareTaxOption[];
}) {
  // Sensitive fields are write-only: the GET payload only ever tells us
  // "present"/"absent" (never the real value), so the input always starts
  // blank and we surface the stored status as text alongside it.
  if (field.sensitive) {
    const present = isSensitivePresent(field, masked);
    return (
      <div className="space-y-1">
        <p className="text-xs text-faint">
          Currently: <span className={present ? "text-success" : "text-muted"}>{present ? "set" : "not set"}</span>
        </p>
        <input
          type="password"
          className="inp"
          autoComplete="off"
          placeholder="Leave blank to keep unchanged"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  }

  if (field.type === "select") {
    // A schema-declared option list wins; otherwise (e.g. general_sales_tax_id)
    // the options come from the live Square catalog taxes fetch.
    const options = field.options && field.options.length > 0
      ? field.options
      : (squareTaxes ?? []).map((t) => ({
          value: t.id,
          label: t.percentage ? `${t.name} (${t.percentage}%)` : t.name,
        }));
    return (
      <select className="inp" value={value} required={field.required} onChange={(e) => onChange(e.target.value)}>
        <option value="">— select —</option>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    );
  }

  const inputType = field.type === "money" ? "text" : field.type === "number" ? "number" : field.type;
  return (
    <input
      type={inputType}
      className="inp"
      inputMode={field.type === "money" ? "decimal" : undefined}
      required={field.required}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
