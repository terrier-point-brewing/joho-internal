"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
import Banner from "@/app/components/ui/Banner";
import { queryKeys } from "@/lib/query-keys";
import { useBreweryTimezone } from "@/app/hooks/useBreweryTimezone";

export default function BusinessSettings() {
  const qc = useQueryClient();
  const { timezone, label, options, isLoading } = useBreweryTimezone();

  // `picked` is null until the user actually changes the dropdown, so the field
  // follows the loaded/refreshed server value without a sync effect. Reset to
  // null after a save so it re-tracks the new value.
  const [picked, setPicked] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const selected = picked ?? timezone;
  const dirty = picked !== null && picked !== timezone;

  async function handleSave() {
    setError(null);
    setSuccess(false);
    setSaving(true);
    try {
      const res = await fetch("/api/settings/timezone", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: selected }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to save timezone");
      } else {
        setSuccess(true);
        setPicked(null); // re-track the freshly saved server value
        // Refresh the active zone everywhere (label + timezone-aware reports).
        await qc.invalidateQueries({ queryKey: queryKeys.settings.breweryTimezone() });
        await qc.invalidateQueries({ queryKey: queryKeys.taproom.all() });
      }
    } catch {
      setError("Failed to save timezone");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex-1 overflow-auto px-4 sm:px-6">
    <div className="max-w-xl">
      <StickyHeader>
        <PageHeader
          title="Business"
          description="Location-wide settings that apply across every report and dashboard."
        />
      </StickyHeader>
      <div className="pb-4 sm:pb-8">
      {error && <Banner tone="danger" className="mb-4">{error}</Banner>}
      {success && <Banner tone="success" className="mb-4">Timezone updated. Reports now use {label}.</Banner>}

      <section className="mt-4 bg-surface border border-line rounded-lg p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-primary">Reporting timezone</h2>
        <p className="text-xs text-secondary mt-1">
          The physical timezone of the taproom. Sales, targets, and every day-,
          week-, and quarter-bucketed metric are calculated in this zone — not in
          the timezone of whoever is viewing the report. Change it only if the
          taproom physically relocates.
        </p>

        <div className="mt-4 rounded-md bg-surface-mid border border-line-subtle px-3 py-2">
          <div className="text-xs text-muted">Currently applied everywhere</div>
          <div className="text-sm font-medium text-primary mt-0.5">
            {isLoading ? "Loading…" : label}
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-1">
          <label htmlFor="tz" className="text-xs font-medium text-secondary">Timezone</label>
          <select
            id="tz"
            className="inp"
            value={selected}
            disabled={isLoading || options.length === 0}
            onChange={(e) => setPicked(e.target.value)}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            className="btn-primary"
            disabled={!dirty || saving}
            onClick={handleSave}
          >
            {saving ? "Saving…" : "Save timezone"}
          </button>
          {dirty && !saving && (
            <span className="text-xs text-muted">Unsaved change</span>
          )}
        </div>
      </section>
      </div>
    </div>
    </div>
  );
}
