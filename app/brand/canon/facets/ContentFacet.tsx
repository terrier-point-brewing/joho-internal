"use client";

import { useState } from "react";
import type { BrandCanon } from "@/lib/brand/canon.types";
import { canonSchema } from "@/lib/brand/canon.schema";
import Banner from "@/app/components/ui/Banner";

const CONTENT_KEYS = ["mission", "voice", "naming", "precedence", "agentRules"] as const;

const contentSectionSchema = canonSchema.pick({
  mission: true,
  voice: true,
  naming: true,
  precedence: true,
  agentRules: true,
});

function pickContent(draft: BrandCanon) {
  const out: Record<string, unknown> = {};
  for (const key of CONTENT_KEYS) out[key] = draft[key];
  return out;
}

/**
 * Free-form JSON editor for the text sections (mission/voice/naming/precedence/
 * agentRules) — these are prose-heavy and don't warrant per-field structured
 * controls. Validates against a canonSchema.pick() slice on blur; merges into
 * the draft only when valid.
 */
export default function ContentFacet({
  draft,
  onChange,
}: {
  draft: BrandCanon;
  onChange: (next: BrandCanon) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(pickContent(draft), null, 2));
  const [error, setError] = useState<string | null>(null);

  function handleBlur() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid JSON");
      return;
    }

    const result = contentSectionSchema.safeParse(parsed);
    if (!result.success) {
      setError(result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      return;
    }

    setError(null);
    onChange({ ...draft, ...result.data });
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Content</h3>
      <p className="text-xs text-faint">
        JSON for mission, voice, naming, precedence, and agentRules. Validated on blur.
      </p>
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
