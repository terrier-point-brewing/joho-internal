"use client";

import { useState, cloneElement, isValidElement, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import type { BrandCanon } from "@/lib/brand/canon.types";
import PageHeader from "@/app/components/PageHeader";
import TabBar from "@/app/components/TabBar";
import ToggleChip from "@/app/components/ui/ToggleChip";
import CanonEditor, { type CanonSection } from "../canon/CanonEditor";
import CanonHistory from "../canon/CanonHistory";

type TabKey = CanonSection | "history";
type Mode = "view" | "edit";

const CANON_SECTIONS: readonly TabKey[] = [
  "ethos",
  "voice",
  "visual",
  "color",
  "type",
  "marks",
  "release",
  "agent",
];

function isCanonSection(tab: TabKey): tab is CanonSection {
  return (CANON_SECTIONS as readonly string[]).includes(tab);
}

/**
 * In-page tabs for the Brand Guide. Every authenticated user gets read-only
 * View mode across Ethos / Voice / Visual Identity / Color / Type / Marks /
 * Release Design / Agent Rules. Admins additionally get a single View/Edit toggle and a History
 * tab: in Edit mode each tab swaps its rendered content for the matching canon
 * editor (every tab → its own introduction, plus its own slice; color→Palette
 * +Theme, type→Type+use cases, marks→artwork upload + spec sheets).
 *
 * The editor is kept mounted once opened — hidden, not unmounted — so unsaved
 * draft edits survive both switching tabs and toggling back to View.
 */
export default function BrandGuideTabs({
  isAdmin,
  publishedCanon,
  views,
}: {
  isAdmin: boolean;
  /** The live canon — lets the editor's publish bar name what differs. */
  publishedCanon?: BrandCanon;
  views: {
    ethos: ReactNode;
    voice: ReactNode;
    visual: ReactNode;
    agent: ReactNode;
    color: ReactNode;
    type: ReactNode;
    marks: ReactNode;
    release: ReactNode;
  };
}) {
  // `?tab=release` deep-links a subtab — Brand → Releases points its "Read:
  // Release Design" links here. Read once on mount, not written back on
  // switch, and validated so an unknown value falls back rather than blanking
  // the page. Same convention as gl-mapping's `?tab=`.
  const searchParams = useSearchParams();
  const [active, setActive] = useState<TabKey>(() => {
    const requested = searchParams.get("tab");
    return requested && isCanonSection(requested as TabKey) ? (requested as TabKey) : "ethos";
  });
  const [mode, setMode] = useState<Mode>("view");
  const [editorMounted, setEditorMounted] = useState(false);

  const tabs: { key: TabKey; label: string }[] = [
    { key: "ethos", label: "Ethos" },
    { key: "voice", label: "Voice" },
    { key: "visual", label: "Visual Identity" },
    { key: "color", label: "Color" },
    { key: "type", label: "Type" },
    { key: "marks", label: "Marks" },
    { key: "release", label: "Release Design" },
    { key: "agent", label: "Agent Rules" },
    ...(isAdmin ? [{ key: "history" as TabKey, label: "History" }] : []),
  ];

  const editing = isAdmin && mode === "edit";
  const editorSection: CanonSection = isCanonSection(active) ? active : "ethos";

  function setModeSafe(next: Mode) {
    if (next === "edit") setEditorMounted(true);
    setMode(next);
  }

  // History has no editor; keep it in View regardless of the toggle.
  const showCanonEditor = editing && isCanonSection(active);

  // Rendered inside each subtab's own intro card (top-right corner) rather
  // than once above all of them — admin-only, and never on History, which
  // has no editor for the toggle to switch into.
  const modeToggle = isAdmin ? (
    <div className="flex items-center gap-1 shrink-0" role="group" aria-label="Mode">
      {(["view", "edit"] as Mode[]).map((m) => (
        <ToggleChip key={m} active={mode === m} onClick={() => setModeSafe(m)}>
          {m === "view" ? "View" : "Edit"}
        </ToggleChip>
      ))}
    </div>
  ) : undefined;

  /** Injects the mode toggle into an already-built view element as its `topRight` prop. */
  function withModeToggle(view: ReactNode): ReactNode {
    return modeToggle && isValidElement(view) ? cloneElement(view, { topRight: modeToggle } as object) : view;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Fixed header + subtab region — mirrors the app-wide page shell */}
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-8">
        <PageHeader
          title="Brand Guide"
          description="The living brand canon — ethos, voice, color, type, and marks."
        />
        <TabBar tabs={tabs} activeKey={active} onSelect={setActive} className="mt-2 mb-0" />
      </div>

      {/* Scrollable content region */}
      <div className="flex-1 overflow-auto px-4 sm:px-6 pb-8 pt-4">
        {/* View mode — each tab's rendered content */}
        <div className={!editing && active === "ethos" ? "" : "hidden"}>{withModeToggle(views.ethos)}</div>
        <div className={!editing && active === "voice" ? "" : "hidden"}>{withModeToggle(views.voice)}</div>
        <div className={!editing && active === "visual" ? "" : "hidden"}>{withModeToggle(views.visual)}</div>
        <div className={!editing && active === "color" ? "" : "hidden"}>{withModeToggle(views.color)}</div>
        <div className={!editing && active === "type" ? "" : "hidden"}>{withModeToggle(views.type)}</div>
        <div className={!editing && active === "marks" ? "" : "hidden"}>{withModeToggle(views.marks)}</div>
        <div className={!editing && active === "release" ? "" : "hidden"}>{withModeToggle(views.release)}</div>
        <div className={!editing && active === "agent" ? "" : "hidden"}>{withModeToggle(views.agent)}</div>

        {/* Edit mode — canon editor (kept mounted once opened) */}
        {isAdmin && editorMounted && (
          <div className={showCanonEditor ? "" : "hidden"}>
            <CanonEditor section={editorSection} publishedCanon={publishedCanon} />
          </div>
        )}

        {/* History — admin, view-only */}
        {isAdmin && active === "history" && <CanonHistory />}
      </div>
    </div>
  );
}
