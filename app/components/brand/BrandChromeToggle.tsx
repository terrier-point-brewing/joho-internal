"use client";

import { useState } from "react";

// Admin control: apply the brand palette to the whole internal app (on) or use
// the default zinc/amber system (off). App-wide setting; a reload shows the new
// skin (the ops --color-* override is injected server-side in the root layout).
export default function BrandChromeToggle({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    const next = !enabled;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/brand/chrome", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `Request failed (${res.status})`);
      }
      setEnabled(next);
      // The skin is applied by a server component in the root layout, so a
      // reload is the simplest way to reflect it everywhere.
      window.location.reload();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={toggle}
        disabled={saving}
        aria-pressed={enabled}
        className={`btn-xxs ${enabled ? "btn-primary" : "btn-secondary"}`}
        title="Apply the brand palette to the whole internal app"
      >
        {saving ? "Saving…" : enabled ? "Brand skin: on" : "Brand skin: off"}
      </button>
      {error && <span className="text-2xs text-danger">{error}</span>}
    </div>
  );
}
