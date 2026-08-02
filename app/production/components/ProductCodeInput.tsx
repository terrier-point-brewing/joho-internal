"use client";

// Inline per-variation product code — saves on blur, only when changed. The
// code sits on the recipe↔variation link because each sellable format carries
// its own code. Shared by Production → Recipes and the Brand release frame:
// registering a code is a release-execution step, so the release owner can do
// it without leaving the frame, but the data's home stays in Production.

import { useState } from "react";
import type { RecipePackagingVariation } from "../types";

export default function ProductCodeInput({
  link,
  onSaved,
}: {
  link: RecipePackagingVariation;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(link.product_code ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (value.trim() === (link.product_code ?? "")) return;
    setSaving(true);
    try {
      const res = await fetch("/api/production/recipe-packaging-variations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: link.id, product_code: value.trim() || null }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? "Save failed");
      onSaved();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Save failed");
      setValue(link.product_code ?? "");
    } finally {
      setSaving(false);
    }
  }

  return (
    <label className="flex items-center gap-1.5">
      <span className="text-xs text-faint">Code</span>
      <input
        className="inp text-xs w-32 py-1"
        placeholder="product code"
        value={value}
        disabled={saving}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      />
    </label>
  );
}
