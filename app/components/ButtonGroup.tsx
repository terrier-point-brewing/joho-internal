"use client";

import ToggleChip from "./ui/ToggleChip";
import type { TabDef } from "./TabBar";

/**
 * Exclusive-choice button row for a view/panel switcher nested one level
 * below a page's own subtab bar (e.g. Chart of Accounts' Statement/By Type
 * toggle, GL Mapping's Revenue/Expenses/... panel picker). Deliberately not
 * a TabBar: an underline tab row reads as page-level navigation, and a
 * second one directly under the real subtabs reads as a third nav level
 * that isn't there. Chips make clear this switches a view within the page,
 * not the page itself.
 */
export default function ButtonGroup<K extends string>({
  tabs,
  activeKey,
  onSelect,
  className = "",
}: {
  tabs: TabDef<K>[];
  activeKey: K;
  onSelect: (key: K) => void;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-1.5 flex-wrap ${className}`.trim()}>
      {tabs.map(({ key, label }) => (
        <ToggleChip key={key} active={key === activeKey} onClick={() => onSelect(key)}>
          {label}
        </ToggleChip>
      ))}
    </div>
  );
}
