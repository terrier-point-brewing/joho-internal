"use client";

import { useMemo } from "react";
import type { GuideRule, Polarity, StoredRule } from "@/lib/brand/guideRules";
import { normalizeRules } from "@/lib/brand/guideRules";
import { useAssets } from "@/app/brand/assets/useAssets";
import ListField from "./ListField";

/**
 * Typed editor for a list of illustrated rules.
 *
 * Normalizes on the way in, so a legacy list of bare strings becomes editable
 * rich rules the first time an admin opens the tab; saving writes the rich
 * shape back. That means the data migrates itself through use, and migration
 * 20260904 exists only to catch rows nobody edits.
 */
export default function RuleListField({
  label,
  description,
  rules,
  onChange,
  defaultPolarity,
}: {
  label: string;
  description: string;
  rules: StoredRule[] | undefined;
  onChange: (next: GuideRule[]) => void;
  defaultPolarity: Polarity;
}) {
  const normalized = useMemo(
    () => normalizeRules(rules, defaultPolarity),
    [rules, defaultPolarity],
  );

  // Only `example` assets are offered — a mark or a photo in a do/don't slot
  // would be a mistake, and filtering here is cheaper than explaining it.
  const { data: assets } = useAssets("example");

  return (
    <ListField<GuideRule>
      label={label}
      description={description}
      addLabel="Add rule"
      items={normalized}
      onChange={onChange}
      blank={() => ({
        id: crypto.randomUUID(),
        polarity: defaultPolarity,
        title: "",
      })}
      renderItem={(rule, update) => (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <select
              className="inp-sm w-24 shrink-0"
              value={rule.polarity}
              onChange={(e) => update({ polarity: e.target.value as Polarity })}
              aria-label="Polarity"
            >
              <option value="do">Do</option>
              <option value="dont">Don&apos;t</option>
            </select>
            <input
              className="inp-sm flex-1"
              value={rule.title}
              onChange={(e) => update({ title: e.target.value })}
              aria-label="Rule"
              placeholder="The rule, in one line"
            />
          </div>

          <input
            className="inp-sm"
            value={rule.detail ?? ""}
            onChange={(e) => update({ detail: e.target.value || undefined })}
            aria-label="Detail"
            placeholder="Why, or the nuance (optional)"
          />

          <div className="flex items-center gap-2">
            <select
              className="inp-sm flex-1"
              value={rule.assetId ?? ""}
              onChange={(e) => update({ assetId: e.target.value || undefined })}
              aria-label="Example image"
            >
              <option value="">No image yet</option>
              {(assets ?? []).map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.title || `${asset.variant} · ${asset.format}`}
                </option>
              ))}
            </select>
            <input
              className="inp-sm flex-1"
              value={rule.caption ?? ""}
              onChange={(e) => update({ caption: e.target.value || undefined })}
              aria-label="Caption"
              placeholder="What the image shows (optional)"
            />
          </div>
        </div>
      )}
    />
  );
}
