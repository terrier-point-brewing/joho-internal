"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BrandCanon } from "@/lib/brand/canon.types";
import { isSectionDirty, pickSectionPatch } from "@/lib/brand/canonSections";
import type { GuideSectionKey } from "@/lib/brand/guideIntros";
import { usePatchSection } from "./useCanonEditor";

export type SaveState = "idle" | "saving" | "saved" | "error";

/** How long after the last keystroke a section saves itself. */
const DEBOUNCE_MS = 800;

interface Snapshot {
  draft: BrandCanon | null;
  serverDraft: BrandCanon | undefined;
  section: GuideSectionKey;
}

/**
 * Debounced per-section autosave.
 *
 * Replaces the old "type, then remember to press Save" flow, which combined
 * badly with the JSON facets: an invalid blob silently failed to reach the
 * draft, the Save button stayed disabled reading "No unsaved changes", and the
 * edit was simply lost. Saving on a timer makes the result observable.
 *
 * Flushes on subtab switch and on window blur as well as on the timer, so an
 * edit can't be stranded by navigating away mid-debounce.
 */
export function useSectionAutosave({
  draft,
  serverDraft,
  section,
  enabled,
}: {
  draft: BrandCanon | null;
  serverDraft: BrandCanon | undefined;
  section: GuideSectionKey;
  enabled: boolean;
}) {
  const patch = usePatchSection();
  const [state, setState] = useState<SaveState>("idle");

  // The blur handler and the flush-on-switch effect need whatever is current at
  // the moment they fire, not what was current when they were registered.
  // Synced in an effect rather than during render — reading or writing a ref
  // mid-render is not allowed.
  const latest = useRef<Snapshot>({ draft, serverDraft, section });
  useEffect(() => {
    latest.current = { draft, serverDraft, section };
  });

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const save = useCallback(
    async (target: GuideSectionKey) => {
      const { draft: current, serverDraft: server } = latest.current;
      if (!current || !isSectionDirty(current, server, target)) return;

      setState("saving");
      try {
        await patch.mutateAsync({ section: target, patch: pickSectionPatch(current, target) });
        setState("saved");
      } catch {
        // The error object is surfaced to the caller via patch.error; this only
        // drives the per-section indicator.
        setState("error");
      }
    },
    [patch],
  );

  /** Save now, cancelling any pending debounce. */
  const flush = useCallback(
    (target?: GuideSectionKey) => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      return save(target ?? latest.current.section);
    },
    [save],
  );

  const dirty = enabled && isSectionDirty(draft, serverDraft, section);

  // The debounce itself. Restarts on every edit to this section.
  useEffect(() => {
    if (!dirty) return;

    const target = section;
    timer.current = setTimeout(() => {
      timer.current = null;
      void save(target);
    }, DEBOUNCE_MS);

    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [dirty, draft, section, save]);

  // Switching subtabs flushes the one being left — otherwise an edit made
  // within the debounce window is silently dropped on navigation.
  const previousSection = useRef(section);
  useEffect(() => {
    const leaving = previousSection.current;
    if (leaving === section) return;
    previousSection.current = section;
    if (enabled) void flush(leaving);
  }, [section, enabled, flush]);

  // Same reasoning for leaving the window entirely.
  useEffect(() => {
    if (!enabled) return;
    const onBlur = () => void flush();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [enabled, flush]);

  // While a section has unsaved edits its indicator reads "idle" (a save is
  // coming) rather than showing a stale "Saved" from the previous keystroke.
  return { state: dirty ? "idle" : state, dirty, flush, error: patch.error as Error | null };
}
