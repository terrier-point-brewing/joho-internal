"use client";

import { useState } from "react";
import type { BrandCanon } from "@/lib/brand/canon.types";
import Banner from "@/app/components/ui/Banner";
import ConfirmDialog from "@/app/components/ui/ConfirmDialog";
import SaveHint from "@/app/components/ui/SaveHint";
import BrandPreview from "./BrandPreview";
import PaletteFacet from "./facets/PaletteFacet";
import ThemeFacet from "./facets/ThemeFacet";
import TypeFacet from "./facets/TypeFacet";
import MarksFacet from "./facets/MarksFacet";
import SliceJsonFacet from "./facets/SliceJsonFacet";
import { ethosSlice, voiceSlice, visualSlice, agentSlice, colorForbiddenSlice } from "./facets/canonSlices";
import { useDraft, usePublish, useSaveDraft } from "./useCanonEditor";

/** Which guide tab's editor is shown. One draft/publish state spans them all. */
export type CanonSection = "ethos" | "voice" | "visual" | "agent" | "color" | "type" | "marks";

/**
 * Admin canon editor. Holds one editable draft copy + a shared publish bar and
 * live preview; the active guide tab decides which facet(s) edit it:
 *   ethos/voice/visual/agent → each tab's own content slice
 *   color → Palette + Theme + forbidden list   type → Type
 *   marks → Mark specification sheets
 * The caller keeps this mounted across tab switches (and across the view/edit
 * toggle) so in-progress edits survive.
 */
export default function CanonEditor({ section }: { section: CanonSection }) {
  const { data: serverDraft, isLoading, error: loadError } = useDraft();
  const saveDraft = useSaveDraft();
  const publish = usePublish();

  const [draft, setDraft] = useState<BrandCanon | null>(null);
  // Tracks which server draft object we've already seeded `draft` from, so a
  // background refetch (same reference until it changes) never clobbers
  // in-progress edits. Set during render (React's documented "adjusting state
  // when a prop changes" pattern), not in an effect — the guard below
  // prevents render loops.
  const [seededFrom, setSeededFrom] = useState<BrandCanon | null>(null);
  const [versionLabel, setVersionLabel] = useState("");
  const [changelog, setChangelog] = useState("");
  const [confirming, setConfirming] = useState(false);

  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(serverDraft);

  // Re-seed `draft` from a fresh server value, but never while a save is
  // in flight or edits are pending — a post-save refetch landing mid-edit
  // would otherwise clobber unsaved changes made after Save was clicked.
  if (serverDraft && serverDraft !== seededFrom && !saveDraft.isPending && !dirty) {
    setSeededFrom(serverDraft);
    setDraft(serverDraft);
  }

  async function handlePublish() {
    if (!draft) return;
    if (dirty) await saveDraft.mutateAsync(draft);
    await publish.mutateAsync({
      versionLabel: versionLabel.trim() || undefined,
      changelog: changelog.trim() || undefined,
    });
    setConfirming(false);
    setVersionLabel("");
    setChangelog("");
  }

  if (isLoading) return <p className="text-sm text-muted">Loading…</p>;
  if (loadError) return <Banner tone="danger">{(loadError as Error).message}</Banner>;
  if (!draft) return null;

  return (
    <div className="flex flex-col gap-4">
      {(saveDraft.error || publish.error) && (
        <Banner tone="danger">
          {((saveDraft.error ?? publish.error) as Error).message}
        </Banner>
      )}

      {/* Publish bar */}
      <div className="flex flex-wrap items-center gap-2 bg-surface border border-line rounded-lg p-3">
        <span className="text-xs text-muted">
          {dirty ? "Unsaved changes" : "No unsaved changes"}
        </span>
        <SaveHint saving={saveDraft.isPending} />
        <div className="flex-1" />
        <input
          className="inp-sm w-32"
          placeholder="version (auto)"
          value={versionLabel}
          onChange={(e) => setVersionLabel(e.target.value)}
        />
        <input
          className="inp-sm w-56"
          placeholder="changelog"
          value={changelog}
          onChange={(e) => setChangelog(e.target.value)}
        />
        <button
          type="button"
          className="btn-secondary"
          disabled={!dirty || saveDraft.isPending}
          onClick={() => draft && saveDraft.mutate(draft)}
        >
          Save
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={publish.isPending}
          onClick={() => setConfirming(true)}
        >
          Publish
        </button>
      </div>

      {/* The token preview only reflects palette/type/prose — not marks — so it's
          dropped for the marks editor, which gets the full width instead. */}
      <div className={section === "marks" ? "" : "grid gap-4 lg:grid-cols-[1fr_20rem]"}>
        <div className="flex flex-col gap-6">
          {section === "ethos" && (
            <SliceJsonFacet {...ethosSlice} draft={draft} onChange={setDraft} />
          )}
          {section === "voice" && (
            <SliceJsonFacet {...voiceSlice} draft={draft} onChange={setDraft} />
          )}
          {section === "visual" && (
            <SliceJsonFacet {...visualSlice} draft={draft} onChange={setDraft} />
          )}
          {section === "agent" && (
            <SliceJsonFacet {...agentSlice} draft={draft} onChange={setDraft} />
          )}
          {section === "color" && (
            <>
              <PaletteFacet draft={draft} onChange={setDraft} />
              <ThemeFacet draft={draft} onChange={setDraft} />
              <SliceJsonFacet {...colorForbiddenSlice} draft={draft} onChange={setDraft} />
            </>
          )}
          {section === "type" && <TypeFacet draft={draft} onChange={setDraft} />}
          {section === "marks" && <MarksFacet draft={draft} onChange={setDraft} />}
        </div>

        {section !== "marks" && <BrandPreview draft={draft} />}
      </div>

      {confirming && (
        <ConfirmDialog
          title="Publish canon"
          message="This snapshots the current draft as the new live version and archives the prior published version. Continue?"
          tone="primary"
          confirmLabel="Publish"
          busy={saveDraft.isPending || publish.isPending}
          onConfirm={handlePublish}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
