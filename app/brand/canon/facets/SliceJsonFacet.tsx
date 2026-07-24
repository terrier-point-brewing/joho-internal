"use client";

import { useState } from "react";
import type { ZodType } from "zod";
import type { BrandCanon } from "@/lib/brand/canon.types";
import Banner from "@/app/components/ui/Banner";

/**
 * Generic per-subtab canon editor: edits only the slice of the draft named by
 * `keys`, as a JSON blob validated against `schema` (a canonSchema.pick() over
 * the same keys) on blur. Each Brand Guide subtab (Ethos / Voice / Visual
 * Identity / Agent Rules) owns exactly its own fields through one of these, so
 * no single tab edits another tab's content. Valid edits merge back into the
 * full draft; everything outside the slice is left untouched.
 */
export default function SliceJsonFacet({
  title,
  description,
  keys,
  schema,
  draft,
  onChange,
}: {
  title: string;
  description: string;
  keys: readonly (keyof BrandCanon)[];
  schema: ZodType;
  draft: BrandCanon;
  onChange: (next: BrandCanon) => void;
}) {
  const pick = (from: BrandCanon) => {
    const out: Record<string, unknown> = {};
    for (const key of keys) out[key] = from[key];
    return out;
  };

  const [text, setText] = useState(() => JSON.stringify(pick(draft), null, 2));
  const [error, setError] = useState<string | null>(null);

  function handleBlur() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid JSON");
      return;
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      setError(result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      return;
    }

    setError(null);
    onChange({ ...draft, ...(result.data as Partial<BrandCanon>) });
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
      <p className="text-xs text-faint">{description}</p>
      {error && <Banner tone="danger">{error}</Banner>}
      <textarea
        className="inp font-mono text-xs min-h-[24rem]"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={handleBlur}
        spellCheck={false}
      />
    </div>
  );
}
