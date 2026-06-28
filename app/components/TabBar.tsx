"use client";
import { type ReactNode } from "react";

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
    ? "sticky top-[5.25rem] md:static z-30 bg-zinc-950/95 -mx-4 sm:mx-0 px-4 sm:px-0"
    : "";

  return (
    <div
      className={`flex gap-1 mb-6 border-b border-zinc-800 overflow-x-auto overflow-y-hidden scrollbar-none ${stickyClasses} ${className}`.trim()}
    >
      {tabs.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onSelect(key)}
          className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px ${
            key === activeKey
              ? "text-amber-400 border-amber-500"
              : "text-zinc-500 border-transparent hover:text-zinc-300"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
