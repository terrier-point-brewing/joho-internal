"use client";
import { type ReactNode } from "react";
import { TAB_ROW, tabItem } from "./ui/tabStyles";

export interface TabDef<K extends string> {
  key: K;
  label: ReactNode;
}

export default function TabBar<K extends string>({
  tabs,
  activeKey,
  onSelect,
  sticky = false,
  className = "",
}: {
  tabs: TabDef<K>[];
  activeKey: K;
  onSelect: (key: K) => void;
  sticky?: boolean;
  className?: string;
}) {
  const stickyClasses = sticky
    ? "sticky top-[5.25rem] md:static z-30 bg-canvas/95 -mx-4 sm:mx-0 px-4 sm:px-0"
    : "";

  return (
    <div className={`${TAB_ROW} mb-6 ${stickyClasses} ${className}`.trim()}>
      {tabs.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onSelect(key)}
          className={tabItem(key === activeKey)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
