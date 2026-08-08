"use client";

import { useMemo, type ChangeEvent } from "react";
import type { BrandCanon } from "@/lib/brand/canon.types";
import { normalizePairs, type RulePair, type RulePanel } from "@/lib/brand/rulePairs";
import { useAssets, useUploadAsset } from "@/app/brand/assets/useAssets";
import ListField from "./ListField";

type Law = BrandCanon["illustrationLaw"];

/**
 * Editor for the illustration law: the paired rules.
 *
 * Edited as PAIRS because that is what they are. The previous editor was one
 * flat list with a Do/Don't dropdown per row, which let a rule be written with
 * no opposite and gave no way to say which don't belonged to which do — the
 * relationship existed only in the founder's head, and the guide couldn't show
 * it. Here both halves of a rule are always on screen together, so an
 * unanswered rule is visible as an empty column rather than invisible.
 *
 * Saving writes `pairs` and drops the legacy `rules` list — and the retired
 * `homage` line with it — so a document migrates itself the first time an
 * admin touches this tab.
 */
export default function VisualLawFields({
  draft,
  onChange,
}: {
  draft: BrandCanon;
  onChange: (next: BrandCanon) => void;
}) {
  const law = draft.illustrationLaw;

  // Normalizing on the way in is what makes the legacy list editable: a
  // pre-pairing document opens as pairs with one half filled, ready to have
  // the other half written.
  const pairs = useMemo(() => normalizePairs(law), [law]);

  function writeLaw(next: Partial<Law>) {
    // `rules` is deliberately not carried over — the paired shape replaces it,
    // and keeping both would leave two sources of truth for one subtab.
    // `homage` is dropped for the same reason: it is retired, and each rule's
    // own nuance line carries that kind of caveat now.
    onChange({
      ...draft,
      illustrationLaw: { pairs, ...next },
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <ListField<RulePair>
        label="Visual identity rules"
        description="Each rule and the failure it prevents, side by side. The nuance line says why the rule exists."
        addLabel="Add rule"
        items={pairs}
        onChange={(next) => writeLaw({ pairs: next })}
        blank={() => ({ id: crypto.randomUUID(), title: "", do: {}, dont: {} })}
        renderItem={(pair, update) => (
          <div className="flex flex-col gap-2">
            <input
              className="inp-sm"
              value={pair.title}
              onChange={(e) => update({ title: e.target.value })}
              aria-label="Rule"
              placeholder="The rule, in one line"
            />

            {/* Two columns, matching the card the reader sees. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <PanelFields
                tone="do"
                panel={pair.do}
                ruleTitle={pair.title}
                onChange={(next) => update({ do: next })}
              />
              <PanelFields
                tone="dont"
                panel={pair.dont}
                ruleTitle={pair.title}
                onChange={(next) => update({ dont: next })}
              />
            </div>

            <textarea
              className="inp min-h-16 text-sm"
              value={pair.nuance ?? ""}
              onChange={(e) => update({ nuance: e.target.value || undefined })}
              aria-label="Nuance"
              placeholder="Why the rule exists — the line above both panels."
            />
          </div>
        )}
      />
    </div>
  );
}

function PanelFields({
  tone,
  panel,
  ruleTitle,
  onChange,
}: {
  tone: "do" | "dont";
  panel: RulePanel;
  /** The rule this panel belongs to, so an uploaded file's variant/title says
   *  which pair it illustrates instead of landing in the library as "default". */
  ruleTitle: string;
  onChange: (next: RulePanel) => void;
}) {
  // Only `example` assets are offered — a mark or a photo in a do/don't slot
  // would be a mistake, and filtering here is cheaper than explaining it.
  const { data: assets } = useAssets("example");
  const upload = useUploadAsset();
  const label = tone === "do" ? "Do" : "Don't";

  function set(patch: Partial<RulePanel>) {
    onChange({ ...panel, ...patch });
  }

  // Uploads straight into the same `example`-kind library the dropdown reads
  // from — same bucket, same brand_assets row shape as the Assets tab and the
  // Marks editor — then points this panel at the row it just created. The
  // panel references the asset by id, not by kind+variant, so it renders on
  // the published guide immediately; it doesn't need the library's separate
  // approve step the way a resolveAsset() lookup would.
  async function handleUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const formData = new FormData();
    formData.set("file", file);
    formData.set("kind", "example");
    formData.set("variant", `${ruleTitle || "Untitled rule"} — ${label}`);
    const altOrTitle = panel.caption || panel.brief;
    if (altOrTitle) {
      formData.set("title", altOrTitle);
      formData.set("alt_text", altOrTitle);
    }
    const asset = await upload.mutateAsync(formData);
    set({ assetId: asset.id });
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-line p-2">
      <span
        className={`text-2xs uppercase tracking-wide font-semibold ${
          tone === "do" ? "text-success" : "text-danger"
        }`}
      >
        {label}
      </span>
      <input
        className="inp-sm"
        value={panel.caption ?? ""}
        onChange={(e) => set({ caption: e.target.value || undefined })}
        aria-label={`${label} caption`}
        placeholder="Caption, one line"
      />
      <input
        className="inp-sm"
        value={panel.brief ?? ""}
        onChange={(e) => set({ brief: e.target.value || undefined })}
        aria-label={`${label} art brief`}
        placeholder="What the artwork should show"
      />
      <select
        className="inp-sm"
        value={panel.assetId ?? ""}
        onChange={(e) => set({ assetId: e.target.value || undefined })}
        aria-label={`${label} image`}
      >
        <option value="">No image yet</option>
        {(assets ?? []).map((asset) => (
          <option key={asset.id} value={asset.id}>
            {asset.title || `${asset.variant} · ${asset.format}`}
          </option>
        ))}
      </select>
      <div className="flex items-center gap-2">
        <input
          type="file"
          accept="image/*"
          className="inp-sm"
          onChange={handleUpload}
          disabled={upload.isPending}
          aria-label={`Upload ${label.toLowerCase()} image`}
        />
        {upload.isPending && <span className="text-2xs text-muted">Uploading…</span>}
      </div>
      {upload.error && (
        <span className="text-2xs text-danger">{(upload.error as Error).message}</span>
      )}
    </div>
  );
}
