"use client";

import { useState } from "react";
import type { BrandCanon } from "@/lib/brand/canon.types";
import Banner from "@/app/components/ui/Banner";
import ConfirmDialog from "@/app/components/ui/ConfirmDialog";
import SaveHint from "@/app/components/ui/SaveHint";
import TabBar from "@/app/components/TabBar";
import BrandPreview from "./BrandPreview";
import PaletteFacet from "./facets/PaletteFacet";
import ThemeFacet from "./facets/ThemeFacet";
import TypeFacet from "./facets/TypeFacet";
import ContentFacet from "./facets/ContentFacet";
import { useDraft, usePublish, useSaveDraft } from "./useCanonEditor";

type FacetKey = "palette" | "theme" | "type" | "content";

const FACET_TABS: { key: FacetKey; label: string }[] = [
  { key: "palette", label: "Palette" },
  { key: "theme", label: "Theme" },
  { key: "type", label: "Type" },
  { key: "content", label: "Content" },
];

/**
 * Admin canon editor: loads the draft, holds an editable copy in state, and
 * lets facet tabs edit slices of it. A shared publish bar tracks dirty state,
 * saves the draft, and publishes (with confirmation) a new canon version. A
 * live preview pane reflects the in-progress draft without touching the real
 * app's tokens.
 */
export default function CanonEditorPage() {
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
  const [activeFacet, setActiveFacet] = useState<FacetKey>("palette");
  const [versionLabel, setVersionLabel] = useState("");
  const [changelog, setChangelog] = useState("");
  const [confirming, setConfirming] = useState(false);

  if (serverDraft && serverDraft !== seededFrom) {
    setSeededFrom(serverDraft);
    setDraft(serverDraft);
  }

  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(serverDraft);

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

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-4">
          <TabBar tabs={FACET_TABS} activeKey={activeFacet} onSelect={setActiveFacet} />

          {activeFacet === "palette" && <PaletteFacet draft={draft} onChange={setDraft} />}
          {activeFacet === "theme" && <ThemeFacet draft={draft} onChange={setDraft} />}
          {activeFacet === "type" && <TypeFacet draft={draft} onChange={setDraft} />}
          {activeFacet === "content" && <ContentFacet draft={draft} onChange={setDraft} />}
        </div>

        <BrandPreview draft={draft} />
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
