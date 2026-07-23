"use client";

import { useState, type ReactNode } from "react";
import TabBar from "@/app/components/TabBar";
import CanonEditor, { type FacetKey } from "../canon/CanonEditor";
import CanonHistory from "../canon/CanonHistory";

type TabKey = "guide" | FacetKey | "history";

const EDITOR_FACETS: readonly FacetKey[] = ["palette", "theme", "type", "content"];

// Guide is open to every authenticated user; the canon editor facets and
// version history are admin-only (see lib/auth.ts).
const TABS: { key: TabKey; label: string; adminOnly?: boolean }[] = [
  { key: "guide", label: "Guide" },
  { key: "palette", label: "Palette", adminOnly: true },
  { key: "theme", label: "Theme", adminOnly: true },
  { key: "type", label: "Type", adminOnly: true },
  { key: "content", label: "Content", adminOnly: true },
  { key: "history", label: "History", adminOnly: true },
];

/**
 * In-page tabs for the Brand Guide: the rendered guide plus the canon editor
 * facets (Palette/Theme/Type/Content) and version History. The editor mounts
 * lazily on first visit and then stays mounted (hidden, not unmounted) so
 * unsaved draft edits survive switching to Guide/History and back.
 */
export default function BrandGuideTabs({
  isAdmin,
  guide,
}: {
  isAdmin: boolean;
  guide: ReactNode;
}) {
  const [active, setActive] = useState<TabKey>("guide");
  const [editorMounted, setEditorMounted] = useState(false);

  const tabs = TABS.filter((t) => !t.adminOnly || isAdmin);
  const activeFacet = EDITOR_FACETS.includes(active as FacetKey) ? (active as FacetKey) : null;

  function select(key: TabKey) {
    if (EDITOR_FACETS.includes(key as FacetKey)) setEditorMounted(true);
    setActive(key);
  }

  return (
    <div>
      <TabBar tabs={tabs} activeKey={active} onSelect={select} />
      <div className={active === "guide" ? "" : "hidden"}>{guide}</div>
      {isAdmin && editorMounted && (
        <div className={activeFacet ? "" : "hidden"}>
          <CanonEditor facet={activeFacet ?? "palette"} />
        </div>
      )}
      {isAdmin && active === "history" && <CanonHistory />}
    </div>
  );
}
