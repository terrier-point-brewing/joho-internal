"use client";

import { createContext, useContext, type ReactNode } from "react";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
import SubNav from "@/app/components/SubNav";
import type { SettingsNavEntry } from "./nav-config";

const GroupNavContext = createContext<SettingsNavEntry[] | undefined>(undefined);

/** Provided by SettingsGroupShell so SettingsHeader can render the group's
 * own sub-tabs — without SettingsGroupShell rendering them itself, which
 * would put them above every page's title instead of below it. */
export function SettingsGroupNavProvider({ nav, children }: { nav?: SettingsNavEntry[]; children: ReactNode }) {
  return <GroupNavContext.Provider value={nav}>{children}</GroupNavContext.Provider>;
}

/**
 * The one frozen header shape every settings page uses: title, description,
 * then the group's own sub-tabs — always in that order, always pinned
 * together. `actions` sits beside the title (e.g. a Refresh/Add button);
 * `children` renders below the group sub-tabs for a page's own secondary
 * tab bar (e.g. GL Mapping's Revenue/Expenses/... panel picker).
 */
export default function SettingsHeader({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const nav = useContext(GroupNavContext);
  return (
    <StickyHeader>
      {actions ? (
        <div className="flex items-start justify-between gap-4">
          <PageHeader title={title} description={description} />
          <div className="flex items-center gap-2 shrink-0 mt-4">{actions}</div>
        </div>
      ) : (
        <PageHeader title={title} description={description} />
      )}
      {nav && nav.length > 1 && <SubNav entries={nav} />}
      {children}
    </StickyHeader>
  );
}
