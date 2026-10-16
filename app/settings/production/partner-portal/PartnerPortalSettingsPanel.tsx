"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";

const KEY = ["production", "partner-portal-settings"];

/**
 * The taproom's reserve. A rule, not a per-batch value: the portal applies it
 * to every batch when it works out what a partner may claim.
 */
export default function PartnerPortalSettingsPanel() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: KEY, queryFn: () => fetchJson<{ pct: number }>("/api/production/partner-portal-settings") });
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pct = data?.pct ?? 10;

  async function save() {
    const value = Number(draft || pct);
    if (!Number.isFinite(value) || value < 0 || value > 100) { setError("Enter a percentage between 0 and 100."); return; }
    setError(null);
    setSaving(true);
    const res = await fetch("/api/production/partner-portal-settings", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pct: value }),
    });
    setSaving(false);
    if (!res.ok) { setError((await res.json().catch(() => ({}))).error ?? "Could not save."); return; }
    setDraft("");
    await qc.invalidateQueries({ queryKey: KEY });
  }

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h3 className="text-sm font-medium text-strong mb-2">
          Taproom Reserve
          <span
            className="ml-1.5 text-faint font-normal cursor-help"
            title="Partners can claim the taproom's unshipped share plus anything unassigned, less this reserve. At 10%, a 40 bbl batch never offers its last 4 bbl."
            aria-label="Example"
          >
            ⓘ
          </span>
        </h3>
        <p className="text-xs text-faint mb-2">Share of every batch never offered to partners.</p>
        <div className="flex items-center gap-2">
          <input
            type="number" min={0} max={100} step={1}
            value={draft !== "" ? draft : pct}
            onChange={(e) => setDraft(e.target.value)}
            className="inp-sm w-20"
            aria-label="Taproom reserve percent"
          />
          <span className="text-xs text-muted">% of each batch</span>
          <button onClick={save} disabled={saving} className="btn-primary">{saving ? "Saving…" : "Save"}</button>
        </div>
        {error && <p className="text-xs text-danger mt-2">{error}</p>}
      </section>

      <section>
        <h3 className="text-sm font-medium text-strong mb-2">Partner logins</h3>
        <div className="flex flex-wrap gap-2">
          <Link href="/settings/environment/users" className="btn-secondary" title="A partner login is a user with the partner role, linked to one company.">
            Add a partner user
          </Link>
          <Link href="/production/partners" className="btn-secondary" title="Tick “Beer is exclusive” on a company to keep its beer from being offered to other partners.">
            Mark a partner exclusive
          </Link>
          <Link href="/partner" className="btn-secondary" title="See the portal as a partner company sees it.">
            Preview the portal
          </Link>
        </div>
      </section>
    </div>
  );
}
