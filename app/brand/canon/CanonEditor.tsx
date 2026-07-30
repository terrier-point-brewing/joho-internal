"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { BrandCanon } from "@/lib/brand/canon.types";
import type { GuideSectionKey } from "@/lib/brand/guideIntros";
import Banner from "@/app/components/ui/Banner";
import ConfirmDialog from "@/app/components/ui/ConfirmDialog";
import SaveHint from "@/app/components/ui/SaveHint";
import PaletteFacet from "./facets/PaletteFacet";
import ThemeFacet from "./facets/ThemeFacet";
import TypeFacet from "./facets/TypeFacet";
import MarksFacet from "./facets/MarksFacet";
import IntroFacet from "./facets/IntroFacet";
import SliceJsonFacet from "./facets/SliceJsonFacet";
import { ethosSlice, voiceSlice, visualSlice, agentSlice, colorForbiddenSlice } from "./facets/canonSlices";
import { useDraft, usePublish } from "./useCanonEditor";
import { useSectionAutosave, type SaveState } from "./useSectionAutosave";
import { changedSections } from "@/lib/brand/canonSections";
import { diffCanon, renderChangelog } from "@/lib/brand/diffCanon";

/** Which guide tab's editor is shown. One draft/publish state spans them all. */
export type CanonSection = GuideSectionKey;

const SAVE_LABEL: Record<SaveState, string> = {
  idle: "Saves automatically",
  saving: "Saving…",
  saved: "Saved",
  error: "Save failed",
};

const SECTION_LABEL: Record<GuideSectionKey, string> = {
  ethos: "Ethos",
  voice: "Voice",
  visual: "Visual Identity",
  color: "Color",
  type: "Type",
  marks: "Marks",
  agent: "Agent Rules",
};

/**
 * Admin canon editor. Holds one editable draft copy + a shared publish bar and
 * live preview; every tab edits its own introduction block, and the active tab
 * decides which further facet(s) edit it:
 *   ethos/voice/visual/agent → each tab's own content slice
 *   color → Palette + Theme + forbidden list   type → Type
 *   marks → Mark specification sheets
 * The caller keeps this mounted across tab switches (and across the view/edit
 * toggle) so in-progress edits survive.
 */
export default function CanonEditor({
  section,
  publishedCanon,
}: {
  section: CanonSection;
  /** The live canon, so the publish bar can name which subtabs differ. */
  publishedCanon?: BrandCanon;
}) {
  const router = useRouter();
  const { data: serverDraft, isLoading, error: loadError } = useDraft();
  const publish = usePublish();

  const [draft, setDraft] = useState<BrandCanon | null>(null);
  // Tracks which server draft object we've already seeded `draft` from, so a
  // background refetch (same reference until it changes) never clobbers
  // in-progress edits. Set during render (React's documented "adjusting state
  // when a prop changes" pattern), not in an effect — the guard below
  // prevents render loops.
  const [seededFrom, setSeededFrom] = useState<BrandCanon | null>(null);
  const [versionLabel, setVersionLabel] = useState("");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);

  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(serverDraft);

  const autosave = useSectionAutosave({
    draft,
    serverDraft,
    section,
    enabled: !!draft,
  });

  // Re-seed `draft` from a fresh server value, but never while a save is in
  // flight or edits are pending. Autosave makes refetch-vs-edit races far more
  // frequent than the manual-save flow did, so this guard matters more now, not
  // less — usePatchSection deliberately updates the cache in place rather than
  // invalidating, precisely to keep this quiet.
  if (serverDraft && serverDraft !== seededFrom && autosave.state !== "saving" && !dirty) {
    setSeededFrom(serverDraft);
    setDraft(serverDraft);
  }

  // Which subtabs differ from what's live — the publish bar's summary, and the
  // source of the changelog preview shown before committing.
  const pendingSections = changedSections(publishedCanon, draft ?? undefined);
  const pendingChangelog =
    publishedCanon && draft ? renderChangelog(diffCanon(publishedCanon, draft)) : "";

  async function handlePublish() {
    if (!draft) return;
    // Flush the active section first so an in-flight debounce can't publish a
    // draft that's missing the edit still sitting in the textarea.
    await autosave.flush();
    await publish.mutateAsync({
      versionLabel: versionLabel.trim() || undefined,
      changelog: note.trim() || undefined,
    });
    setConfirming(false);
    setVersionLabel("");
    setNote("");
    // The route handler's revalidateTag("brand-canon") only busts the server's
    // data cache — it doesn't push an update to the already-mounted View tab,
    // which holds the ReactNode the server rendered at initial page load.
    // Without this, Publish "succeeds" but View mode keeps showing the
    // pre-publish content until a manual hard reload.
    router.refresh();
  }

  if (isLoading) return <p className="text-sm text-muted">Loading…</p>;
  if (loadError) return <Banner tone="danger">{(loadError as Error).message}</Banner>;
  if (!draft) return null;

  return (
    <div className="flex flex-col gap-4">
      {(autosave.error || publish.error) && (
        <Banner tone="danger">
          {((autosave.error ?? publish.error) as Error).message}
        </Banner>
      )}

      {/* Publish bar */}
      <div className="flex flex-wrap items-center gap-2 bg-surface border border-line rounded-lg p-3">
        <span className="text-xs text-muted">{SAVE_LABEL[autosave.state]}</span>
        <SaveHint saving={autosave.state === "saving"} />
        <div className="flex-1" />
        {pendingSections.length > 0 && (
          <span className="text-xs text-secondary">
            Unpublished: {pendingSections.map((s) => SECTION_LABEL[s]).join(", ")}
          </span>
        )}
        <input
          className="inp-sm w-32"
          placeholder="version (auto)"
          value={versionLabel}
          onChange={(e) => setVersionLabel(e.target.value)}
        />
        <input
          className="inp-sm w-56"
          placeholder="note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button
          type="button"
          className="btn-secondary"
          disabled={!autosave.dirty}
          onClick={() => void autosave.flush()}
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

      {/* Every section gets the full width. The old two-column layout existed
          only to host the Live Preview card, which showed the same fixed swatch
          grid regardless of which subtab you were on and was irrelevant on five
          of the seven. The editors themselves are the preview. */}
      <div>
        <div className="flex flex-col gap-6">
          <IntroFacet section={section} draft={draft} onChange={setDraft} />
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
      </div>

      {confirming && (
        <ConfirmDialog
          title="Publish canon"
          message={
            pendingChangelog
              ? `This snapshots the draft as the new live version and archives the prior one. The changelog below is generated automatically.\n\n${pendingChangelog}`
              : "This snapshots the current draft as the new live version and archives the prior published version. No content has changed since the last publish."
          }
          tone="primary"
          confirmLabel="Publish"
          busy={autosave.state === "saving" || publish.isPending}
          onConfirm={handlePublish}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
