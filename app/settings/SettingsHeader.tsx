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
 * together. Nothing else belongs in the frozen header: action buttons,
 * status text, and every other control live in the scrollable content
 * below. `children` renders below the group sub-tabs for a page's own
 * secondary view switcher (e.g. GL Mapping's Revenue/Expenses/... picker,
 * rendered as a ButtonGroup rather than a second TabBar).
 */
export default function SettingsHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  const nav = useContext(GroupNavContext);
  return (
    <StickyHeader divider={!children && !(nav && nav.length > 1)}>
      <PageHeader title={title} description={description} />
      {nav && nav.length > 1 && <SubNav entries={nav} />}
      {children}
    </StickyHeader>
  );
}
