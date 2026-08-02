"use client";

import { useState, type ReactNode } from "react";
import type { BrandCanon } from "@/lib/brand/canon.types";
import PageHeader from "@/app/components/PageHeader";
import TabBar from "@/app/components/TabBar";
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
  const [active, setActive] = useState<TabKey>("ethos");
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

  return (
    <div className="flex flex-col h-full">
      {/* Fixed header + subtab region — mirrors the app-wide page shell */}
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-8">
        <PageHeader
          title="Brand Guide"
          description="Terrier Point's living brand canon — ethos, voice, color, type, and marks."
        />
        <div className="flex items-end justify-between gap-4 mt-2">
          <TabBar tabs={tabs} activeKey={active} onSelect={setActive} className="flex-1 mb-0" />
          {isAdmin && active !== "history" && (
            <div className="flex items-center gap-1 pb-2 shrink-0" role="group" aria-label="Mode">
              {(["view", "edit"] as Mode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setModeSafe(m)}
                  aria-pressed={mode === m}
                  className={`btn-xxs ${mode === m ? "btn-primary" : "btn-secondary"}`}
                >
                  {m === "view" ? "View" : "Edit"}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Scrollable content region */}
      <div className="flex-1 overflow-auto px-4 sm:px-6 pb-8 pt-4">
        {/* View mode — each tab's rendered content */}
        <div className={!editing && active === "ethos" ? "" : "hidden"}>{views.ethos}</div>
        <div className={!editing && active === "voice" ? "" : "hidden"}>{views.voice}</div>
        <div className={!editing && active === "visual" ? "" : "hidden"}>{views.visual}</div>
        <div className={!editing && active === "color" ? "" : "hidden"}>{views.color}</div>
        <div className={!editing && active === "type" ? "" : "hidden"}>{views.type}</div>
        <div className={!editing && active === "marks" ? "" : "hidden"}>{views.marks}</div>
        <div className={!editing && active === "release" ? "" : "hidden"}>{views.release}</div>
        <div className={!editing && active === "agent" ? "" : "hidden"}>{views.agent}</div>

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
