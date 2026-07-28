import SubNav from "@/app/components/SubNav";
import { SETTINGS_GROUPS, type SettingsNavEntry } from "./nav-config";

/**
 * The chrome every settings group shares, so the seven group layouts differ
 * only in which capability they gate on and which sub-nav they pass.
 *
 * Shape follows docs/UI_STANDARD.md §4: the group row is the area nav, which
 * lives in the app sidebar on desktop and appears here only under `md` — the
 * same `<SubNav … mobile />` pattern production and taproom pages use. Below it
 * sits the group's own sub-tabs, and settings stops there. There is no third
 * nav level.
 *
 * Horizontal padding is applied once, here, to both nav rows. Content padding
 * stays with the pages because several of them (the finance tables) are
 * full-height with their own sticky header and internal scroll region — hence
 * the `flex-1 min-h-0 flex flex-col` content slot, which gives those pages the
 * bounded flex column they are written against.
 */
export default function SettingsGroupShell({
  nav,
  children,
}: {
  /** The group's sub-tabs. Omit for a single-page group — Catalog. */
  nav?: SettingsNavEntry[];
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 px-4 sm:px-6">
        <SubNav entries={SETTINGS_GROUPS} mobile sticky />
        {nav && nav.length > 1 && <SubNav entries={nav} />}
      </div>
      <div className="flex-1 min-h-0 flex flex-col">{children}</div>
    </div>
  );
}
