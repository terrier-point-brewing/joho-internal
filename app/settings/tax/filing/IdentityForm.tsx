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
 * route merges, per lib/tax/profiles.ts). A sensitive field's real value is
 * only ever fetched on an explicit "Unmask" click, from `GET
 * {endpoint}/reveal` (admin-only, lib/tax/profiles.pickSensitiveValues) —
 * never as part of the regular masked GET above. The `general_sales_tax_id`
 * select (type "select" with no static `options`) is populated from
 * Square's live catalog taxes via `/api/tax/square-taxes`.
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

  const needsSquareTaxes = schema.some((f) => f.source === "square_tax");
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

  // Per-field "unmask" state for `sensitive` fields — `fetched` tracks whether
  // this field's real value has been pulled from `{endpoint}/reveal` at least
  // once (so toggling visibility again doesn't re-fetch); `visible` tracks
  // whether it's currently shown in the clear vs. masked as a password input.
  const [fetched, setFetched] = useState<Record<string, boolean>>({});
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [revealingKey, setRevealingKey] = useState<string | null>(null);
  const [revealErrors, setRevealErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (profileQuery.data && !initializedRef.current) {
      setValues(initialFormValues(schema, profileQuery.data));
      // A fresh masked payload means any previously revealed value is stale
      // (re-blanked by initialFormValues) — drop the reveal state with it.
      setFetched({});
      setVisible({});
      setRevealErrors({});
      initializedRef.current = true;
    }
  }, [profileQuery.data, schema]);

  function setField(key: string, value: string) {
    setValues((cur) => ({ ...cur, [key]: value }));
    setSaved(false);
  }

  async function handleToggleReveal(fieldKey: string) {
    if (fetched[fieldKey]) {
      setVisible((cur) => ({ ...cur, [fieldKey]: !cur[fieldKey] }));
      return;
    }
    setRevealingKey(fieldKey);
    setRevealErrors((cur) => ({ ...cur, [fieldKey]: "" }));
    try {
      const revealed = await fetchJson<Record<string, string>>(`${endpoint}/reveal`);
      setValues((cur) => ({ ...cur, [fieldKey]: revealed[fieldKey] ?? "" }));
      setFetched((cur) => ({ ...cur, [fieldKey]: true }));
      setVisible((cur) => ({ ...cur, [fieldKey]: true }));
    } catch (err) {
      setRevealErrors((cur) => ({
        ...cur,
        [fieldKey]: err instanceof Error ? err.message : "Failed to reveal value.",
      }));
    } finally {
      setRevealingKey(null);
    }
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
          {schema.map((field) => {
            const present = isSensitivePresent(field, profileQuery.data);
            const hint = field.sensitive ? (
              <>
                {field.help ? `${field.help} — ` : null}
                Currently: <span className={present ? "text-success" : "text-muted"}>{present ? "set" : "not set"}</span>
              </>
            ) : (
              field.help
            );
            return (
              <Field key={field.key} label={field.label} required={field.required} hint={hint}>
                <IdentityFieldInput
                  field={field}
                  value={values[field.key] ?? ""}
                  onChange={(v) => setField(field.key, v)}
                  squareTaxes={squareTaxesQuery.data}
                  visible={!!visible[field.key]}
                  revealing={revealingKey === field.key}
                  revealError={revealErrors[field.key]}
                  onToggleReveal={() => handleToggleReveal(field.key)}
                />
              </Field>
            );
          })}
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
  squareTaxes,
  visible,
  revealing,
  revealError,
  onToggleReveal,
}: {
  field: FieldSpec;
  value: string;
  onChange: (v: string) => void;
  squareTaxes?: SquareTaxOption[];
  visible?: boolean;
  revealing?: boolean;
  revealError?: string;
  onToggleReveal?: () => void;
}) {
  // Sensitive fields are write-only by default: the GET payload only ever
  // tells us "present"/"absent" (never the real value), so the input starts
  // blank/masked. "Unmask" fetches the real value on demand from
  // `{endpoint}/reveal` (admin-only) — see handleToggleReveal — and toggles
  // this input to type="text" so the retrieved value is actually readable.
  if (field.sensitive) {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <input
            type={visible ? "text" : "password"}
            className="inp flex-1"
            autoComplete="off"
            placeholder="Leave blank to keep unchanged"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          <button type="button" className="btn-secondary shrink-0" onClick={onToggleReveal} disabled={revealing}>
            {revealing ? "Loading…" : visible ? "Hide" : "Unmask"}
          </button>
        </div>
        {revealError && <p className="text-xs text-danger">{revealError}</p>}
      </div>
    );
  }

  if (field.type === "select") {
    // `source: "square_tax"` means the options are the live Square catalog
    // taxes; anything else uses the schema's own static option list.
    const options = field.source !== "square_tax"
      ? (field.options ?? [])
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
