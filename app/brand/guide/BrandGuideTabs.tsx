"use client";

import { useState, type ReactNode } from "react";
import PageHeader from "@/app/components/PageHeader";
import TabBar from "@/app/components/TabBar";
import CanonEditor, { type CanonSection } from "../canon/CanonEditor";
import CanonHistory from "../canon/CanonHistory";
import MarksEditor from "./MarksEditor";

type TabKey = "guide" | "color" | "type" | "marks" | "history";
type Mode = "view" | "edit";

const CANON_SECTIONS: readonly TabKey[] = ["guide", "color", "type", "marks"];

function isCanonSection(tab: TabKey): tab is CanonSection {
  return (CANON_SECTIONS as readonly string[]).includes(tab);
}

/**
 * In-page tabs for the Brand Guide. Every authenticated user gets read-only
 * View mode across Guide / Color / Type / Marks. Admins additionally get a
 * single View/Edit toggle and a History tab: in Edit mode each tab swaps its
 * rendered content for the matching canon editor (guide→Content prose,
 * color→Palette+Theme, type→Type; marks are managed in the Assets tab).
 *
 * The editor is kept mounted once opened — hidden, not unmounted — so unsaved
 * draft edits survive both switching tabs and toggling back to View.
 */
export default function BrandGuideTabs({
  isAdmin,
  views,
}: {
  isAdmin: boolean;
  views: { guide: ReactNode; color: ReactNode; type: ReactNode; marks: ReactNode };
}) {
  const [active, setActive] = useState<TabKey>("guide");
  const [mode, setMode] = useState<Mode>("view");
  const [editorMounted, setEditorMounted] = useState(false);

  const tabs: { key: TabKey; label: string }[] = [
    { key: "guide", label: "Guide" },
    { key: "color", label: "Color" },
    { key: "type", label: "Type" },
    { key: "marks", label: "Marks" },
    ...(isAdmin ? [{ key: "history" as TabKey, label: "History" }] : []),
  ];

  const editing = isAdmin && mode === "edit";
  const editorSection: CanonSection = isCanonSection(active) ? active : "guide";

  function setModeSafe(next: Mode) {
    if (next === "edit") setEditorMounted(true);
    setMode(next);
  }

  // History has no editor; keep it in View regardless of the toggle.
  const showCanonEditor = editing && isCanonSection(active);
  const showMarksEditor = editing && active === "marks";

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
        <div className={!editing && active === "guide" ? "" : "hidden"}>{views.guide}</div>
        <div className={!editing && active === "color" ? "" : "hidden"}>{views.color}</div>
        <div className={!editing && active === "type" ? "" : "hidden"}>{views.type}</div>
        <div className={!editing && active === "marks" ? "" : "hidden"}>{views.marks}</div>

        {/* Edit mode — canon editor (kept mounted once opened) */}
        {/* Marks edit: upload the artwork (Assets) above the spec-sheet editor. */}
        {showMarksEditor && (
          <div className="mb-6">
            <MarksEditor />
          </div>
        )}
        {isAdmin && editorMounted && (
          <div className={showCanonEditor ? "" : "hidden"}>
            <CanonEditor section={editorSection} />
          </div>
        )}

        {/* History — admin, view-only */}
        {isAdmin && active === "history" && <CanonHistory />}
      </div>
    </div>
  );
}
