"use client";

import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Banner from "@/app/components/ui/Banner";
import { queryKeys } from "@/lib/query-keys";
import { validateFilingUrl } from "@/lib/tax/obligations";

interface FilingPortalFormProps {
  /** Obligation key (`tax_obligations.key`, same string as the party template's key). */
  partyKey: string;
  /** Current stored link, from `GET /api/tax/parties`. */
  filingUrl: string | null;
}

/**
 * Edits `tax_obligations.filing_url` — where this module's return is actually
 * submitted. Mounted per module and keyed on `partyKey` by the page, so
 * switching modules remounts with fresh state (same reason IdentityForm is
 * keyed).
 */
export default function FilingPortalForm({ partyKey, filingUrl }: FilingPortalFormProps) {
  const qc = useQueryClient();
  const [value, setValue] = useState(filingUrl ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validationError = validateFilingUrl(value);
  const dirty = (value.trim() || null) !== (filingUrl ?? null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (validationError) return;

    setSubmitting(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/tax/obligations/${partyKey}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filing_url: value.trim() || null }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to save filing link.");
      await qc.invalidateQueries({ queryKey: queryKeys.tax.parties() });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      {error && <Banner tone="danger">{error}</Banner>}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="url"
          inputMode="url"
          className="inp flex-1 min-w-64"
          placeholder="https://eservices.dor.nc.gov/..."
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
          }}
        />
        <button type="submit" className="btn-primary" disabled={submitting || !!validationError || !dirty}>
          {submitting ? "Saving…" : "Save"}
        </button>
      </div>
      {validationError ? (
        <p className="text-xs text-danger">{validationError}</p>
      ) : (
        <p className="text-xs text-faint">
          Optional. Shown as a link on this module&apos;s schedules and open tasks under Finance → Tax. Leave blank if
          the return isn&apos;t filed online.
        </p>
      )}
      {saved && <p className="text-xs text-success">Filing link saved.</p>}
    </form>
  );
}
